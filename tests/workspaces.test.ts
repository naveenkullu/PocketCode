import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { createSession } from "../src/auth/session-service.js";
import { openDatabase } from "../src/storage/database.js";
import { createServer, type GitHubAppConfig } from "../src/server/index.js";
import { WorkspaceService, MAX_FILE_BYTES, MAX_FILES, MAX_WORKSPACE_BYTES } from "../src/workspaces/workspace-service.js";

const KEY="0123456789abcdef".repeat(4);
const privateKey=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
const githubApp:GitHubAppConfig={clientId:"Iv1.test",clientSecret:"client-secret",slug:"test",appId:"12345",privateKey,callbackUrl:"http://localhost/auth",tokenEncryptionKey:KEY};
const config={port:3000,host:"127.0.0.1",publicBaseUrl:"http://localhost:3000",githubApp};

describe("workspace root configuration",()=>{
 it("uses WORKSPACE_ROOT when configured",()=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),"pocketcode-workspace-env-"));const root=path.join(temp,"configured");const previous=process.env.WORKSPACE_ROOT;process.env.WORKSPACE_ROOT=root;const db=openDatabase(":memory:");
  try{new WorkspaceService(db);assert.equal(existsSync(root),true);}
  finally{db.close();if(previous===undefined)delete process.env.WORKSPACE_ROOT;else process.env.WORKSPACE_ROOT=previous;rmSync(temp,{recursive:true,force:true});}
 });
 it("preserves the os.tmpdir default when WORKSPACE_ROOT is absent",()=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),"pocketcode-workspace-default-"));const previous=process.env.WORKSPACE_ROOT;const previousTmpdir=process.env.TMPDIR;const previousTmp=process.env.TMP;const previousTemp=process.env.TEMP;
  process.env.TMPDIR=temp;process.env.TMP=temp;process.env.TEMP=temp;delete process.env.WORKSPACE_ROOT;const db=openDatabase(":memory:");
  try{new WorkspaceService(db);const expected=path.join(temp,"pocketcode-workspaces");assert.equal(existsSync(expected),true);}
  finally{db.close();if(previous===undefined)delete process.env.WORKSPACE_ROOT;else process.env.WORKSPACE_ROOT=previous;for(const [key,value] of [["TMPDIR",previousTmpdir],["TMP",previousTmp],["TEMP",previousTemp]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(temp,{recursive:true,force:true});}
 });
 it("uses an explicit constructor root instead of WORKSPACE_ROOT",()=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),"pocketcode-workspace-override-"));const configured=path.join(temp,"configured");const explicit=path.join(temp,"explicit");const previous=process.env.WORKSPACE_ROOT;process.env.WORKSPACE_ROOT=configured;const db=openDatabase(":memory:");
  try{new WorkspaceService(db,{rootDirectory:explicit});assert.equal(existsSync(explicit),true);assert.equal(existsSync(configured),false);}
  finally{db.close();if(previous===undefined)delete process.env.WORKSPACE_ROOT;else process.env.WORKSPACE_ROOT=previous;rmSync(temp,{recursive:true,force:true});}
 });
});

function fixture(fetchImpl:typeof fetch=async()=>{throw Error("unexpected request")}){
 const temp=mkdtempSync(path.join(os.tmpdir(),"pocketcode-ws-test-"));const root=path.join(temp,"workspaces");const db=openDatabase(":memory:");
 for(const [id,githubId,name] of [["u1","11","alice"],["u2","22","bob"]])db.prepare("INSERT INTO users(id,github_user_id,github_username) VALUES(?,?,?)").run(id,githubId,name);
 const s1=createSession(db,"u1",{expiresInMs:7*86400000}),s2=createSession(db,"u2",{expiresInMs:7*86400000});const sid1=(db.prepare("SELECT id FROM sessions WHERE user_id='u1'").get() as {id:string}).id;
 const installation=()=>db.prepare(`INSERT INTO github_installations(id,user_id,installation_id,account_id,account_login,account_type,repository_selection,status) VALUES('record','u1','70','1','octo','User','all','active')`).run();
 const app=createServer({config,database:db,fetchImpl,workspaceRoot:root});
 const headers={cookie:`pocketcode_session=${s1.token}`,origin:config.publicBaseUrl,"x-csrf-token":createHmac("sha256",Buffer.from(KEY,"hex")).update(`pocketcode-csrf:${sid1}`).digest("base64url")};
 return {temp,root,db,s1,s2,sid1,headers,installation,app};
}
function githubMock(files:Record<string,string>={"src/a.ts":"hello\n",".env":"secret","bin.dat":"\0bad"},calls:string[]=[]):typeof fetch{
 const branches=new Map<string,string>([["main","a".repeat(40)]]);
 return async(input,init)=>{const u=new URL(String(input));const method=init?.method??"GET";calls.push(`${method} ${u.pathname}`);
  if(u.pathname.endsWith("/app/installations/70"))return Response.json({id:70,app_id:12345,account:{id:1,login:"octo",type:"User"},repository_selection:"all",suspended_at:null});
 if(u.pathname.endsWith("/access_tokens"))return Response.json({token:"ghs-very-secret",expires_at:new Date(Date.now()+60000).toISOString()});
 if(u.pathname.endsWith("/installation/repositories"))return Response.json({repositories:[{id:321,name:"demo",full_name:"octo/demo",owner:{login:"octo"},private:true,html_url:"https://github.com/octo/demo",default_branch:"main",permissions:{pull:true,push:false,admin:false}}]});
 if(u.pathname==="/repos/octo/demo"&&method==="GET")return Response.json({id:321,name:"demo",owner:{login:"octo"},default_branch:"main"});
 if(u.pathname.startsWith("/repos/octo/demo/branches/")&&method==="GET"){const ref=decodeURIComponent(u.pathname.slice("/repos/octo/demo/branches/".length));const sha=branches.get(ref);return sha?Response.json({commit:{sha,commit:{tree:{sha:"tree-sha"}}}}):Response.json({}, {status:404});}
 if(u.pathname==="/repos/octo/demo/git/refs"&&method==="POST"){const body=JSON.parse(String(init?.body)) as {ref:string;sha:string};const ref=body.ref.replace(/^refs\/heads\//,"");if(branches.has(ref))return Response.json({}, {status:422});branches.set(ref,body.sha);return Response.json({ref:body.ref,object:{sha:body.sha}},{status:201});}
 if(u.pathname.endsWith("/git/trees/tree-sha")){const tree=Object.entries(files).map(([p,c],i)=>({path:p,type:"blob",sha:`blob-${i}`,size:Buffer.byteLength(c)}));return Response.json({tree,truncated:false});}
 const m=u.pathname.match(/\/git\/blobs\/blob-(\d+)$/);if(m){const content=Object.values(files)[Number(m[1])]!;return Response.json({encoding:"base64",content:Buffer.from(content).toString("base64")});}
 return Response.json({}, {status:404});};
}

describe("isolated workspace service",()=>{
 it("creates owned workspaces, keeps original immutable, applies approved proposals and rejects duplicates",()=>{const f=fixture();const svc=new WorkspaceService(f.db,{rootDirectory:f.root});try{const w=svc.create("u1", f.sid1, "321","main","sha",[{path:"a.txt",content:"original"}]);const c=svc.propose(w.id,"u1","edit_file","a.txt","changed");assert.equal(svc.originalSnapshot(w.id,"u1","a.txt"),"original");assert.equal(svc.readFile(w.id,"u1","a.txt").content,"original");assert.equal(svc.decide(w.id,"u1",c.id,"approve").status,"approved");assert.equal(svc.readFile(w.id,"u1","a.txt").content,"changed");assert.equal(svc.originalSnapshot(w.id,"u1","a.txt"),"original");assert.throws(()=>svc.decide(w.id,"u1",c.id,"approve"),(e:any)=>e.code==="invalid_transition");assert.throws(()=>svc.getInfo(w.id,"u2"),(e:any)=>e.statusCode===404);}finally{f.db.close();rmSync(f.temp,{recursive:true,force:true});}});
 it("supports multiple creates/edits/deletes, rejection and stale proposal rejection",()=>{const f=fixture();const s=new WorkspaceService(f.db,{rootDirectory:f.root});try{const w=s.create("u1",f.sid1,"321","main","sha",[{path:"old.txt",content:"old"},{path:"edit.txt",content:"before"}]);const create=s.propose(w.id,"u1","create_file","new.txt","new");const edit=s.propose(w.id,"u1","edit_file","edit.txt","after");const del=s.propose(w.id,"u1","delete_file","old.txt");s.decide(w.id,"u1",create.id,"approve");assert.throws(()=>s.decide(w.id,"u1",edit.id,"approve"),(e:any)=>e.code==="stale_proposal");const edit2=s.propose(w.id,"u1","edit_file","edit.txt","after");s.decide(w.id,"u1",edit2.id,"approve");const del2=s.propose(w.id,"u1","delete_file","old.txt");s.decide(w.id,"u1",del2.id,"approve");const rejected=s.propose(w.id,"u1","create_file","no.txt","no");s.decide(w.id,"u1",rejected.id,"reject");assert.equal(s.listFiles(w.id,"u1").some(x=>x.path==="old.txt"),false);assert.equal(s.readFile(w.id,"u1","edit.txt").content,"after");assert.throws(()=>s.readFile(w.id,"u1","no.txt"),(e:any)=>e.code==="file_not_found");assert.equal(s.originalSnapshot(w.id,"u1","old.txt"),"old");}finally{f.db.close();rmSync(f.temp,{recursive:true,force:true});}});
 it("rejects traversal, symlinks and limit violations",()=>{const f=fixture();const s=new WorkspaceService(f.db,{rootDirectory:f.root});try{assert.throws(()=>s.create("u1",f.sid1,"1","main","s",[{path:"../escape",content:"x"}]));assert.throws(()=>s.create("u1",f.sid1,"1","main","s",[{path:".env.local",content:"x"}]));assert.throws(()=>s.create("u1",f.sid1,"1","main","s",[{path:"large.txt",content:"x".repeat(MAX_FILE_BYTES+1)}]),(e:any)=>e.code==="file_too_large");assert.throws(()=>s.create("u1",f.sid1,"1","main","s",Array.from({length:MAX_FILES+1},(_,i)=>({path:`${i}.txt`,content:""}))),(e:any)=>e.code==="file_count_limit");assert.throws(()=>s.create("u1",f.sid1,"1","main","s",[{path:"large.txt",content:"x".repeat(MAX_WORKSPACE_BYTES+1)}]));const w=s.create("u1",f.sid1,"1","main","s",[{path:"ok.txt",content:"ok"}]);symlinkSync(f.temp,path.join(f.root,w.id,"current","escape"),"junction");assert.throws(()=>s.readFile(w.id,"u1","escape\0x"));}finally{f.db.close();rmSync(f.temp,{recursive:true,force:true});}});
 it("loads bounded sanitized snapshot from the persistent branch and exposes no physical paths or GitHub token",async()=>{const calls:string[]=[];const fetchImpl=githubMock({"src/a.ts":"hello\n",".env":"secret","private.pem":"secret","binary":"\0bad"},calls);const f=fixture(fetchImpl);f.installation();try{const branch=await f.app.inject({method:"POST",url:"/api/repository-connections",headers:f.headers,payload:{repositoryId:"321",confirmed:true}});assert.equal(branch.statusCode,200,branch.body);calls.length=0;const branchRef=branch.json().connection.featureBranch;const res=await f.app.inject({method:"POST",url:"/api/workspaces",headers:f.headers,payload:{repositoryId:"321",branchRef}});assert.equal(res.statusCode,201,res.body);assert.equal(res.json().branchRef,branchRef);assert.equal(res.json().fileCount,1);assert.doesNotMatch(res.body,/ghs-very-secret|workspaces|[A-Z]:\\/i);const id=res.json().id;assert.equal((await f.app.inject({method:"GET",url:`/api/workspaces/${id}/files`,headers:f.headers})).json().files.length,1);const cross=await f.app.inject({method:"GET",url:`/api/workspaces/${id}`,headers:{cookie:`pocketcode_session=${f.s2.token}`}});assert.equal(cross.statusCode,404);const create=await f.app.inject({method:"POST",url:`/api/workspaces/${id}/changes`,headers:f.headers,payload:{operation:"create_file",path:"new.txt",content:"new"}});assert.equal(create.statusCode,201);const change=create.json();const before=await f.app.inject({method:"GET",url:`/api/workspaces/${id}/file?path=new.txt`,headers:f.headers});assert.equal(before.statusCode,404);const approved=await f.app.inject({method:"POST",url:`/api/workspaces/${id}/changes/${change.id}/approve`,headers:f.headers});assert.equal(approved.statusCode,200);assert.equal((await f.app.inject({method:"GET",url:`/api/workspaces/${id}/file?path=new.txt`,headers:f.headers})).json().content,"new");assert.equal(calls.some(x=>x.startsWith("POST ")&&x.includes("/git/refs")),false);assert.equal(calls.some(x=>x.startsWith("PUT ")||x.startsWith("PATCH ")||x.startsWith("DELETE ")),false);}finally{await f.app.close();rmSync(f.temp,{recursive:true,force:true});}});
 it("sweeps expired workspaces idempotently",()=>{const f=fixture();const svc=new WorkspaceService(f.db,{rootDirectory:f.root});try{const w=svc.create("u1",f.sid1,"1","main","sha",[{path:"a",content:"a"}]);f.db.prepare("DELETE FROM workspaces WHERE id=?").run(w.id);assert.equal(svc.cleanupExpired(),0);assert.equal(svc.cleanupExpired(),0);assert.throws(()=>svc.getInfo(w.id,"u1"),(e:any)=>e.statusCode===404);}finally{f.db.close();rmSync(f.temp,{recursive:true,force:true});}});
});