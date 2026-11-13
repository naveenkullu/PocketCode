import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, realpathSync, renameSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { RepoTarget } from "../auth/github-repository-explorer.js";

export const WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_WORKSPACE_BYTES = 10 * 1024 * 1024;
const SECRET_NAME = /(^|\/)(\.env(?:\..*)?|[^/]*(?:secret|credential|private[-_]?key|\.pem$|\.key$)[^/]*)$/i;
const nowIso = () => new Date().toISOString();

export class WorkspaceError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}

export interface SnapshotFile { path: string; content: string }
export interface WorkspaceOptions {
  database: Database.Database;
  rootDirectory?: string;
  now?: () => number;
}

export function validateWorkspacePath(input: unknown): string {
  if (typeof input !== "string" || !input || input.length > 4096 || input.includes("\0") || input.includes("\\") ||
      input.startsWith("/") || /^[A-Za-z]:/.test(input) || input.startsWith("//") ||
      input.split("/").some((part) => !part || part === "." || part === "..")) throw new WorkspaceError("invalid_path");
  return input;
}

function checkText(pathname: string, content: string): number {
  validateWorkspacePath(pathname);
  if (SECRET_NAME.test(pathname)) throw new WorkspaceError("excluded_file", 415);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) throw new WorkspaceError("file_too_large", 413);
  if (content.includes("\0") || Buffer.from(content, "utf8").toString("utf8") !== content) throw new WorkspaceError("binary_file_unsupported", 415);
  return bytes;
}

function safeFile(root: string, relative: string, mustExist: boolean): string {
  validateWorkspacePath(relative);
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${root}${path.sep}`)) throw new WorkspaceError("invalid_path");
  let current = root;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) throw new WorkspaceError("symlink_not_allowed", 400);
      if (i < parts.length - 1 && !st.isDirectory()) throw new WorkspaceError("invalid_path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !mustExist) break;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceError("file_not_found", 404);
      throw error;
    }
  }
  const resolvedRoot = realpathSync(root);
  let parent = path.dirname(target);
  while (parent !== root && !requireExists(parent)) parent = path.dirname(parent);
  const resolvedParent = realpathSync(parent);
  if (resolvedParent !== resolvedRoot && !resolvedParent.startsWith(`${resolvedRoot}${path.sep}`)) throw new WorkspaceError("invalid_path");
  return target;
}

function requireExists(candidate: string): boolean {
  try { lstatSync(candidate); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new WorkspaceError("symlink_not_allowed");
      if (entry.isDirectory()) visit(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit(root, ""); return out.sort();
}

export class WorkspaceService {
  private readonly root: string;
  private readonly now: () => number;
  constructor(private readonly database: Database.Database, options: { rootDirectory?: string; now?: () => number } = {}) {
    this.root = path.resolve(
      options.rootDirectory ??
        (process.env.WORKSPACE_ROOT?.trim() || path.join(os.tmpdir(), "pocketcode-workspaces")),
    );
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.now = options.now ?? Date.now;
    this.cleanupExpired();
  }

  private directory(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new WorkspaceError("workspace_not_found", 404);
    return path.join(this.root, id);
  }
  private get(id: string, userId: string) {
    const row = this.database.prepare("SELECT * FROM workspaces WHERE id=? AND user_id=? AND expires_at>?").get(id, userId, new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "Z")) as any;
    if (!row) throw new WorkspaceError("workspace_not_found", 404);
    return row;
  }
  create(userId: string, sessionId: string, repositoryId: string, branchRef: string, commitSha: string, files: SnapshotFile[]) {
    if (!files.length || files.length > MAX_FILES) throw new WorkspaceError("file_count_limit", 413);
    const normalized = new Map<string, string>(); let total = 0;
    for (const file of files) {
      const name = validateWorkspacePath(file.path);
      const bytes = checkText(name, file.content);
      total += bytes;
      if (total > MAX_WORKSPACE_BYTES) throw new WorkspaceError("workspace_size_limit", 413);
      if (normalized.has(name)) throw new WorkspaceError("duplicate_path");
      normalized.set(name, file.content);
    }
    const id = randomUUID(); const base = this.directory(id); const original = path.join(base, "original"); const current = path.join(base, "current");
    mkdirSync(original, { recursive: true, mode: 0o700 }); mkdirSync(current, { recursive: true, mode: 0o700 });
    try {
      for (const [name, content] of normalized) {
        for (const root of [original, current]) {
          const target = path.join(root, ...name.split("/")); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, content, { flag: "wx", mode: 0o600 });
        }
      }
      const created = new Date(this.now()).toISOString(); const expires = new Date(this.now() + WORKSPACE_TTL_MS).toISOString();
    const insert = this.database.prepare(`INSERT INTO workspaces(id,user_id,session_id,repository_id,branch_ref,source_commit_sha,snapshot_bytes,snapshot_file_count,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const insertFiles = this.database.prepare("INSERT INTO workspace_files(workspace_id,path,content,sha256) VALUES(?,?,?,?)");
    this.database.transaction(() => {
      insert.run(id,userId,sessionId,repositoryId,branchRef,commitSha,total,normalized.size,created,expires);
      for (const [name, content] of normalized) insertFiles.run(id,name,content,createHash("sha256").update(content).digest("hex"));
    })();
      return { id, repositoryId, branchRef, commitSha, version: 0, fileCount: normalized.size, expiresAt: expires };
    } catch (e) { rmSync(base, { recursive: true, force: true }); throw e; }
  }
  list(userId: string) {
    return (this.database.prepare("SELECT id,repository_id AS repositoryId,branch_ref AS branchRef,source_commit_sha AS commitSha,snapshot_file_count AS fileCount,version,created_at AS createdAt,expires_at AS expiresAt FROM workspaces WHERE user_id=? AND expires_at>? ORDER BY created_at DESC").all(userId,new Date(this.now()).toISOString()) as any[]);
  }
  getInfo(id: string, userId: string) { const r=this.get(id,userId); return { id:r.id,repositoryId:r.repository_id,branchRef:r.branch_ref,commitSha:r.source_commit_sha,fileCount:r.snapshot_file_count,version:r.version,createdAt:r.created_at,expiresAt:r.expires_at }; }
  delete(id: string, userId: string) { this.get(id,userId); this.database.prepare("DELETE FROM workspaces WHERE id=? AND user_id=?").run(id,userId); rmSync(this.directory(id),{recursive:true,force:true}); }
  listAllIds() { return this.database.prepare("SELECT id FROM workspaces").all() as Array<{id:string}>; }
  removeDirectory(id:string) { try { rmSync(this.directory(id),{recursive:true,force:true}); } catch {} }
  shutdownCleanup() { for(const {id} of this.listAllIds()){this.database.prepare("DELETE FROM workspaces WHERE id=?").run(id);this.removeDirectory(id);} }
  cleanupExpired() {
    const expired=this.database.prepare("SELECT id FROM workspaces WHERE expires_at<=?").all(new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "Z")) as Array<{id:string}>;
    for(const {id} of expired){ this.database.prepare("DELETE FROM workspaces WHERE id=?").run(id); rmSync(this.directory(id),{recursive:true,force:true}); }
    const known=new Set((this.database.prepare("SELECT id FROM workspaces").all() as Array<{id:string}>).map(x=>x.id));
    for(const entry of readdirSync(this.root,{withFileTypes:true})) if(entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name) && !known.has(entry.name)) rmSync(path.join(this.root,entry.name),{recursive:true,force:true});
    return expired.length;
  }
  listFiles(id:string,userId:string){const row=this.get(id,userId);const root=path.join(this.directory(id),"current");return walk(root).filter(p=>!SECRET_NAME.test(p)).map(p=>({path:p,size:readFileSync(safeFile(root,p,true)).byteLength,deleted:false,version:row.version}));}
  readFile(id:string,userId:string,name:string){this.get(id,userId);validateWorkspacePath(name);if(SECRET_NAME.test(name))throw new WorkspaceError("excluded_file",415);const f=safeFile(path.join(this.directory(id),"current"),name,true);const b=readFileSync(f);if(b.length>MAX_FILE_BYTES||b.includes(0))throw new WorkspaceError(b.length>MAX_FILE_BYTES?"file_too_large":"binary_file_unsupported",415);let content:string;try{content=new TextDecoder("utf-8",{fatal:true}).decode(b);}catch{throw new WorkspaceError("binary_file_unsupported",415);}return {path:name,content};}
  propose(id:string,userId:string,operation:"create_file"|"edit_file"|"delete_file",name:string,content?:string){const w=this.get(id,userId);validateWorkspacePath(name);if(SECRET_NAME.test(name))throw new WorkspaceError("excluded_file",415);const current=path.join(this.directory(id),"current");let original:string|null=null;try{original=this.readFile(id,userId,name).content;}catch(e){if(!(e instanceof WorkspaceError&&e.code==="file_not_found"))throw e;}if(operation==="create_file"&&original!==null)throw new WorkspaceError("file_already_exists",409);if(operation!=="create_file"&&original===null)throw new WorkspaceError("file_not_found",404);if(operation==="delete_file")content=undefined;else if(typeof content!=="string")throw new WorkspaceError("invalid_content");if(content!==undefined)checkText(name,content);const idChange=randomUUID();this.database.prepare(`INSERT INTO workspace_changes(id,workspace_id,user_id,base_version,operation,path,original_content,proposed_content,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(idChange,id,userId,w.version,operation,name,original,content,"pending",nowIso());return this.getChange(idChange,userId);}
  private getChange(id:string,userId:string){const c=this.database.prepare("SELECT * FROM workspace_changes WHERE id=? AND user_id=?").get(id,userId) as any;if(!c)throw new WorkspaceError("change_not_found",404);return c;}
  private diff(c:any){return {path:c.path,operation:c.operation,original:c.original_content,proposed:c.proposed_content};}
  changes(id:string,userId:string){this.get(id,userId);return (this.database.prepare("SELECT * FROM workspace_changes WHERE workspace_id=? AND user_id=? ORDER BY created_at,id").all(id,userId) as any[]).map(c=>({...this.diff(c),id:c.id,status:c.status,baseVersion:c.base_version,diff:this.unified(c.original_content,c.proposed_content)}));}
  getChangeReview(id:string,userId:string,changeId:string){this.get(id,userId);const c=this.getChange(changeId,userId);if(c.workspace_id!==id)throw new WorkspaceError("change_not_found",404);return {...this.diff(c),id:c.id,status:c.status,baseVersion:c.base_version,diff:this.unified(c.original_content,c.proposed_content)};}
  private unified(before:string|null,after:string|null){if(before===after)return "";return `--- original\n+++ proposed\n${before===null?"":"-"+before}${before!==null&&!before.endsWith("\n")?"\n":""}${after===null?"":"+"+after}${after!==null&&!after.endsWith("\n")?"\n":""}`;}
  decide(id:string,userId:string,changeId:string,action:"approve"|"reject"){
    const c=this.getChange(changeId,userId);const w=this.get(id,userId);if(c.workspace_id!==id)throw new WorkspaceError("change_not_found",404);if(c.status!=="pending")throw new WorkspaceError("invalid_transition",409);if(c.base_version!==w.version)throw new WorkspaceError("stale_proposal",409);
    const current=path.join(this.directory(id),"current");const target=safeFile(current,c.path,c.operation!=="create_file");
    let actual:string|null=null;try{const b=readFileSync(target);if(b.length>MAX_FILE_BYTES||b.includes(0))throw new WorkspaceError("binary_file_unsupported",415);actual=new TextDecoder("utf-8",{fatal:true}).decode(b);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    if(actual!==c.original_content)throw new WorkspaceError("stale_proposal",409);
    if(action==="approve"){
      if(c.proposed_content!==null)checkText(c.path,c.proposed_content);
      const entries=walk(current);const existing=entries.filter(p=>p!==c.path);let size=existing.reduce((n,p)=>n+readFileSync(safeFile(current,p,true)).length,0)+(c.proposed_content===null?0:Buffer.byteLength(c.proposed_content));
      if((c.proposed_content!==null&&!entries.includes(c.path)&&entries.length+1>MAX_FILES)||size>MAX_WORKSPACE_BYTES)throw new WorkspaceError("workspace_limit",413);
      const temp=c.proposed_content===null?null:`${target}.${randomUUID()}.tmp`;
      if(temp){mkdirSync(path.dirname(target),{recursive:true,mode:0o700});writeFileSync(temp,c.proposed_content!,{flag:"wx",mode:0o600});}
      try {
        const apply=this.database.transaction(()=>{
          const changed=this.database.prepare("UPDATE workspaces SET version=version+1 WHERE id=? AND user_id=? AND version=?").run(id,userId,w.version);
          if(changed.changes!==1)throw new WorkspaceError("stale_proposal",409);
          const decided=this.database.prepare("UPDATE workspace_changes SET status='approved',decided_at=? WHERE id=? AND user_id=? AND status='pending'").run(nowIso(),changeId,userId);
          if(decided.changes!==1)throw new WorkspaceError("invalid_transition",409);
          if(c.proposed_content===null)this.database.prepare("DELETE FROM workspace_files WHERE workspace_id=? AND path=?").run(id,c.path);
          else this.database.prepare(`INSERT INTO workspace_files(workspace_id,path,content,sha256) VALUES(?,?,?,?) ON CONFLICT(workspace_id,path) DO UPDATE SET content=excluded.content,sha256=excluded.sha256`).run(id,c.path,c.proposed_content,createHash("sha256").update(c.proposed_content).digest("hex"));
        });
        apply();
        if(temp && c.original_content!==null){
          const backup=`${target}.${randomUUID()}.bak`;
          try { copyFileSync(target,backup); renameSync(temp,target); rmSync(backup,{force:true}); }
          catch(error){if(requireExists(backup))renameSync(backup,target);throw error;}
        } else if(temp) renameSync(temp,target);
        else rmSync(target);
      } catch(error){if(temp)rmSync(temp,{force:true});throw error;}
      return {id:changeId,status:"approved",version:w.version+1};
    }
    this.database.prepare("UPDATE workspace_changes SET status='rejected',decided_at=? WHERE id=? AND user_id=? AND status='pending'").run(nowIso(),changeId,userId);
    return {id:changeId,status:"rejected",version:w.version};
  }
  originalSnapshot(id:string,userId:string,name:string){this.get(id,userId);const root=path.join(this.directory(id),"original");return readFileSync(safeFile(root,name,true),"utf8");}
  originalFiles(id:string,userId:string){this.get(id,userId);return (this.database.prepare("SELECT path,content,sha256 FROM workspace_files WHERE workspace_id=? ORDER BY path").all(id) as Array<{path:string;content:string;sha256:string}>);}
}

export async function loadRepositorySnapshot(target:RepoTarget,branchRef:string,fetchImpl:typeof fetch):Promise<{commitSha:string;files:SnapshotFile[]}> {
  const headers={Accept:"application/vnd.github+json",Authorization:`Bearer ${target.token}`,"X-GitHub-Api-Version":"2022-11-28"};
  const request=async(url:string)=>{const r=await fetchImpl(url,{headers,signal:AbortSignal.timeout(10_000)});if(!r.ok)throw new WorkspaceError("github_repository_unavailable",503);return r.json() as Promise<any>;};
  const branch=await request(`https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/branches/${encodeURIComponent(branchRef)}`);
  const commitSha=branch?.commit?.sha;const treeSha=branch?.commit?.commit?.tree?.sha;
  if(typeof commitSha!=="string"||typeof treeSha!=="string")throw new WorkspaceError("github_invalid_response",503);
  const tree=await request(`https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  if(!Array.isArray(tree?.tree)||tree.truncated)throw new WorkspaceError("repository_too_large",413);
  const candidates=tree.tree.filter((x:any)=>x?.type==="blob"&&typeof x.path==="string"&&typeof x.sha==="string"&&Number.isSafeInteger(x.size)&&x.size>=0&&!SECRET_NAME.test(x.path)).sort((a:any,b:any)=>a.path.localeCompare(b.path));
  let total=0;let eligible=0;const files:SnapshotFile[]=[];
  for(const item of candidates){if(item.size>MAX_FILE_BYTES)continue;if(++eligible>MAX_FILES)throw new WorkspaceError("repository_too_large",413);total+=item.size;if(total>MAX_WORKSPACE_BYTES)throw new WorkspaceError("repository_too_large",413);
    const blob=await request(`https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/git/blobs/${encodeURIComponent(item.sha)}`);
    if(blob?.encoding!=="base64"||typeof blob.content!=="string"||blob.content.length>Math.ceil(MAX_FILE_BYTES*4/3)+8)continue;
    const bytes=Buffer.from(blob.content.replace(/\s/g,""),"base64");if(bytes.length!==item.size||bytes.includes(0))continue;
    try{files.push({path:item.path,content:new TextDecoder("utf-8",{fatal:true}).decode(bytes)});}catch{}
  }
  return {commitSha,files};
}