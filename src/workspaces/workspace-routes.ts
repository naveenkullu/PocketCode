import { createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GitHubAppConfig, ServerConfig } from "../server/index.js";
import { GitHubAppApiError } from "../auth/github-app-auth.js";
import { validateSession } from "../auth/session-service.js";
import { loadRepositorySnapshot, WorkspaceError, WorkspaceService } from "./workspace-service.js";
import { RepositoryBranchError, RepositoryBranchService } from "../repositories/repository-branch-service.js";

interface Dependencies {
  database: Database.Database;
  config: ServerConfig;
  validateConfiguration: () => GitHubAppConfig;
  fetchImpl?: typeof fetch;
  workspaceRoot?: string;
  service?: WorkspaceService;
  repositoryBranches: RepositoryBranchService;
  ownsService?: boolean;
  onWorkspace?: (service: WorkspaceService) => void;
}
function cookie(header:string|undefined){return new Map((header??"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf("=");return [x.slice(0,i),x.slice(i+1)] as [string,string]})).get("pocketcode_session");}
function user(request:FastifyRequest,database:Database.Database){return validateSession(database,cookie(request.headers.cookie));}
function csrfValid(request:FastifyRequest,sessionId:string,key:string,config:ServerConfig){const origin=request.headers.origin;const supplied=request.headers["x-csrf-token"];const expected=createHmac("sha256",Buffer.from(key,"hex")).update(`pocketcode-csrf:${sessionId}`).digest("base64url");return typeof origin==="string"&&origin===new URL(config.frontendUrl??config.publicBaseUrl).origin&&typeof supplied==="string"&&supplied.length===expected.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(expected));}
function status(error:unknown){return error instanceof WorkspaceError||error instanceof RepositoryBranchError?error.statusCode:error instanceof GitHubAppApiError?error.code==="rate_limited"?429:503:500;}
function safeError(error:unknown){return error instanceof WorkspaceError||error instanceof RepositoryBranchError?error.code:error instanceof GitHubAppApiError?error.code==="rate_limited"?"github_rate_limited":"github_repository_unavailable":"workspace_unavailable";}
export function registerWorkspaceRoutes(app:FastifyInstance,deps:Dependencies):WorkspaceService{
  const service=deps.service??new WorkspaceService(deps.database,{rootDirectory:deps.workspaceRoot});const fetchImpl=deps.fetchImpl??fetch;const key=deps.config.githubApp?.tokenEncryptionKey;
  deps.onWorkspace?.(service);
  if(deps.ownsService ?? !deps.service)app.addHook("onClose",async()=>{service.shutdownCleanup();});
  app.post("/api/workspaces",async(req,reply)=>{
    const session=user(req,deps.database);if(!session)return reply.header("Cache-Control","no-store").status(401).send({error:"unauthorized"});
    if(!key||!/^[\da-fA-F]{64}$/.test(key)||!csrfValid(req,session.id,key,deps.config))return reply.header("Cache-Control","no-store").status(403).send({error:"forbidden"});
    try{const body=req.body as any;if(!body||typeof body.repositoryId!=="string"||!/^\d{1,20}$/.test(body.repositoryId)||
      body.branchRef!==undefined&&(typeof body.branchRef!=="string"||body.branchRef.length>255))throw new WorkspaceError("invalid_repository_or_ref");
      const config=deps.validateConfiguration();const verified=await deps.repositoryBranches.getForWorkspace(session.userId,body.repositoryId,config);
      if(body.branchRef!==undefined&&body.branchRef!==verified.connection.featureBranch)throw new WorkspaceError("repository_branch_mismatch",409);
      const branchRef=verified.connection.featureBranch;const snapshot=await loadRepositorySnapshot(verified.target,branchRef,fetchImpl);
      const result=service.create(session.userId,session.id,body.repositoryId,branchRef,snapshot.commitSha,snapshot.files);return reply.header("Cache-Control","no-store").status(201).send(result);
    }catch(e){return reply.header("Cache-Control","no-store").status(status(e)).send({error:safeError(e)});}
  });
  app.get("/api/workspaces",async(req,reply)=>{const s=user(req,deps.database);if(!s)return reply.header("Cache-Control","no-store").status(401).send({error:"unauthorized"});return reply.header("Cache-Control","no-store").send({workspaces:service.list(s.userId)});});
  app.get("/api/workspaces/:workspaceId",async(req,reply)=>{const s=user(req,deps.database);if(!s)return reply.header("Cache-Control","no-store").status(401).send({error:"unauthorized"});try{return reply.header("Cache-Control","no-store").send(service.getInfo((req.params as any).workspaceId,s.userId));}catch(e){return reply.header("Cache-Control","no-store").status(status(e)).send({error:safeError(e)});}});
  app.delete("/api/workspaces/:workspaceId",async(req,reply)=>{const s=user(req,deps.database);if(!s)return reply.header("Cache-Control","no-store").status(401).send({error:"unauthorized"});if(!key||!csrfValid(req,s.id,key,deps.config))return reply.status(403).send({error:"forbidden"});try{service.delete((req.params as any).workspaceId,s.userId);return reply.status(204).send();}catch(e){return reply.status(status(e)).send({error:safeError(e)});}});
  app.get("/api/workspaces/:workspaceId/files",async(req,reply)=>{const s=user(req,deps.database);if(!s)return reply.status(401).send({error:"unauthorized"});try{return reply.header("Cache-Control","no-store").send({files:service.listFiles((req.params as any).workspaceId,s.userId)});}catch(e){return reply.status(status(e)).send({error:safeError(e)});}});
  app.get("/api/workspaces/:workspaceId/file",async(req,reply)=>{const s=user(req,deps.database);if(!s)return reply.status(401).send({error:"unauthorized"});try{return reply.header("Cache-Control","no-store").send(service.readFile((req.params as any).workspaceId,s.userId,(req.query as any).path));}catch(e){return reply.status(status(e)).send({error:safeError(e)});}});
  app.post("/api/workspaces/:workspaceId/changes",async(req,reply)=>{const s=user(req,deps.database);if(!s)return reply.status(401).send({error:"unauthorized"});if(!key||!csrfValid(req,s.id,key,deps.config))return reply.status(403).send({error:"forbidden"});try{const b=req.body as any;if(!b||!(["create_file","edit_file","delete_file"] as unknown[]).includes(b.operation))throw new WorkspaceError("invalid_operation");return reply.header("Cache-Control","no-store").status(201).send(service.propose((req.params as any).workspaceId,s.userId,b.operation,b.path,b.content));}catch(e){return reply.status(status(e)).send({error:safeError(e)});}});
  app.get("/api/workspaces/:workspaceId/changes",async(req,reply)=>{const s=user(req,deps.database);if(!s)return reply.status(401).send({error:"unauthorized"});try{return reply.header("Cache-Control","no-store").send({changes:service.changes((req.params as any).workspaceId,s.userId)});}catch(e){return reply.status(status(e)).send({error:safeError(e)});}});
  app.get("/api/workspaces/:workspaceId/changes/:changeId",async(req,reply)=>{const s=user(req,deps.database);if(!s)return reply.status(401).send({error:"unauthorized"});try{return reply.header("Cache-Control","no-store").send(service.getChangeReview((req.params as any).workspaceId,s.userId,(req.params as any).changeId));}catch(e){return reply.status(status(e)).send({error:safeError(e)});}});
  for(const action of ["approve","reject"] as const)app.post(`/api/workspaces/:workspaceId/changes/:changeId/${action}`,async(req,reply)=>{const s=user(req,deps.database);if(!s)return reply.status(401).send({error:"unauthorized"});if(!key||!csrfValid(req,s.id,key,deps.config))return reply.status(403).send({error:"forbidden"});try{return reply.header("Cache-Control","no-store").send(service.decide((req.params as any).workspaceId,s.userId,(req.params as any).changeId,action));}catch(e){return reply.status(status(e)).send({error:safeError(e)});}});
  return service;
}