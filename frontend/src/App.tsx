import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, Code2,
  File as FileIcon, FileCode2, Folder, Github, LoaderCircle, LogOut, Menu, MessageSquare,
  PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings2, ShieldCheck, Sparkles,
  X,
} from "lucide-react";
import "./auth.css";
import "./workspace.css";
import { ProviderSettings } from "./ProviderSettings";

type AuthState = "checking" | "authenticated" | "unauthenticated" | "expired" | "error";
type AuthUser = { id: string; githubUsername: string; csrfToken: string };
type Repository = {
  id: string;
  name: string;
  fullName: string;
  ownerLogin: string;
  private: boolean;
  defaultBranch: string | null;
  htmlUrl: string;
  permissions: { read: boolean; write: boolean };
};
type TreeEntry = { name: string; path: string; type: string; size?: number };
type FileContent = { path: string; content: string; size?: number };
type ChatMessage = { id: string; role: "user" | "assistant"; text: string; time: string };
type AgentToolCall = { name: string; success: boolean; path?: string; error?: string };
type Proposal = {
  id: string;
  path: string;
  operation: string;
  status: string;
  diff: string;
};
type RepositoryBranchConnection = {
  id: string;
  repositoryId: string;
  owner: string;
  repositoryName: string;
  defaultBranch: string;
  baseCommitSha: string;
  featureBranch: string;
  headCommitSha: string | null;
  status: "provisioning" | "active" | "branch_missing" | "access_lost" | "branch_collision" | "recovery_required";
};
type AgentEvent = { id: string; type: string; data?: { phase?: string; name?: string; success?: boolean; error?: string } };

class ApiError extends Error {
  constructor(readonly status: number, readonly code = "", readonly diagnostics?: { retryAfterSeconds?: number }) {
    super(code);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let code = "";
    let diagnostics: { retryAfterSeconds?: number } | undefined;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null) {
        if ("error" in body && typeof body.error === "string") code = body.error;
        if ("diagnostics" in body && typeof body.diagnostics === "object" && body.diagnostics !== null &&
            "retryAfterSeconds" in body.diagnostics && typeof body.diagnostics.retryAfterSeconds === "number") {
          diagnostics = { retryAfterSeconds: body.diagnostics.retryAfterSeconds };
        }
      }
    } catch { /* The status remains sufficient to classify this API failure. */ }
    throw new ApiError(response.status, code, diagnostics);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function apiMessage(error: unknown, area: "repositories" | "files" | "agent" | "workspace" = "agent"): string {
  if (!(error instanceof ApiError)) return "PocketCode could not reach the API. Check your connection and retry.";
  if (error.status === 401) return "Your session has expired. Sign in with GitHub again.";
  if (area === "repositories") {
    if (error.status === 429 || error.code === "github_rate_limited") return "GitHub is rate limiting repository access. Wait a moment, then retry.";
    if (error.code === "github_app_configuration_missing") return "GitHub App setup is incomplete. An administrator must configure the App ID, private key, and slug.";
    if (error.code === "github_app_configuration_invalid") return "GitHub App configuration is invalid. An administrator must review the server configuration.";
    if (error.code === "github_installation_required") return "Install the PocketCode GitHub App on your account or organization to connect repositories.";
    if (error.code === "github_installation_suspended") return "The PocketCode GitHub App installation is suspended. Review the installation in GitHub.";
    if (error.code === "github_installation_unavailable") return "The saved GitHub App installation is no longer available. Reinstall the App to reconnect.";
    if (error.code === "github_insufficient_permissions") return "The GitHub App lacks required repository access. Grant Metadata and Contents read access, then include repositories in the installation.";
    if (error.code === "github_invalid_response") return "GitHub returned an unexpected response. Retry, and contact the administrator if this continues.";
    return "Repositories could not be loaded. Check that the GitHub App has access, then retry.";
  }
  if (error.status === 403) return "PocketCode could not validate this request. Reload the page and try again.";
  if (area === "files") {
    if (error.status === 404) return "This folder or file is no longer available in the selected snapshot.";
    if (error.status === 413 || error.status === 415) return error.code === "file_too_large" ? "This file is too large to preview." : "This file is binary or cannot be previewed as text.";
    return "The repository contents could not be loaded. Retry the request.";
  }
  if (error.code === "provider_not_configured" || error.code === "credential_missing") return "Configure a provider and API key in Settings before starting an agent.";
  if (error.code === "provider_configuration_changed") return "Your provider settings changed. Start a new workspace session.";
  if (error.code === "provider_rate_limited") {
    const retryAfter = error.diagnostics?.retryAfterSeconds;
    return retryAfter ? `The AI provider is rate limiting requests. Please wait ${retryAfter} seconds before trying again.` : "The AI provider is rate limiting requests. Please wait before trying again.";
  }
  if (error.code === "provider_bad_request") return "The AI provider rejected the request. This may be due to an invalid model configuration or context size.";
  if (error.code === "provider_auth_error") return "The AI provider rejected the API credentials. Check your provider settings in Settings.";
  if (error.code === "provider_payload_too_large") return "The request to the AI provider was too large. Try a smaller repository or shorter prompt.";
  if (error.code === "provider_unavailable") return "The AI provider is temporarily unavailable. Please try again in a moment.";
  if (error.code === "provider_timeout") return "The AI provider request timed out. Please try again.";
  if (error.code === "provider_connection_error") return "Could not connect to the AI provider. Check your network connection.";
  if (error.code === "cancelled") return "The agent run was cancelled.";
  if (error.status === 429) return "A PocketCode usage limit was reached. Please wait before trying again.";
  if (area === "workspace") return "PocketCode could not prepare an isolated repository workspace.";
  return "The agent request did not complete. Please try again.";
}

function sessionFromResponse(value: unknown): AuthUser | null {
  if (typeof value !== "object" || value === null || !("user" in value) ||
      typeof value.user !== "object" || value.user === null ||
      !("id" in value.user) || typeof value.user.id !== "string" ||
      !("githubUsername" in value.user) || typeof value.user.githubUsername !== "string" ||
      !("csrfToken" in value) || typeof value.csrfToken !== "string" || !value.csrfToken) return null;
  return { id: value.user.id, githubUsername: value.user.githubUsername, csrfToken: value.csrfToken };
}

function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [loginStarting, setLoginStarting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const authenticatedBefore = useRef(false);
  const [activeSection, setActiveSection] = useState<"Workspace" | "Files" | "Settings">("Workspace");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const expireSession = useCallback(() => {
    setAuthUser(null);
    setAuthState("expired");
    setAuthError("");
    authenticatedBefore.current = false;
  }, []);

  const restoreSession = useCallback(async () => {
    try {
      const value = await requestJson<unknown>("/api/auth/me");
      const user = sessionFromResponse(value);
      if (!user) throw new Error("invalid_session");
      setAuthUser(user);
      setAuthState("authenticated");
      setAuthError("");
      authenticatedBefore.current = true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthUser(null);
        setAuthState(authenticatedBefore.current ? "expired" : "unauthenticated");
        authenticatedBefore.current = false;
        return;
      }
      setAuthError("PocketCode could not verify your session. Check that the local API is running, then retry.");
      setAuthState("error");
    }
  }, []);

  useEffect(() => {
    const callbackStatus = new URLSearchParams(window.location.search).get("auth");
    if (callbackStatus === "connected") setAuthNotice("GitHub sign-in completed. Your session is being restored.");
    if (callbackStatus === "failed") setAuthNotice("GitHub sign-in did not complete. Please try again.");
    if (callbackStatus) window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    void restoreSession();
  }, [restoreSession]);

  const logout = async () => {
    if (!authUser) return;
    setLoggingOut(true);
    setAuthError("");
    try {
      await requestJson<void>("/api/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": authUser.csrfToken },
      });
      setAuthUser(null);
      authenticatedBefore.current = false;
      setAuthState("unauthenticated");
      setAuthNotice("You have been signed out.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expireSession();
      else setAuthError("Could not sign out. Your session may still be active; please retry.");
    } finally {
      setLoggingOut(false);
    }
  };

  if (authState !== "authenticated" || !authUser) {
    return <AuthGate state={authState} error={authError} notice={authNotice}
      loginStarting={loginStarting} onRetry={() => void restoreSession()}
      onLogin={() => { setLoginStarting(true); window.location.assign("/api/auth/github/start"); }} />;
  }

  return <WorkspaceApp
    authUser={authUser}
    authNotice={authNotice}
    activeSection={activeSection}
    setActiveSection={setActiveSection}
    drawerOpen={drawerOpen}
    setDrawerOpen={setDrawerOpen}
    sidebarCollapsed={sidebarCollapsed}
    setSidebarCollapsed={setSidebarCollapsed}
    loggingOut={loggingOut}
    onLogout={() => void logout()}
    onSessionExpired={expireSession}
  />;
}

function AuthGate({ state, error, notice, loginStarting, onLogin, onRetry }: {
  state: AuthState;
  error: string;
  notice: string;
  loginStarting: boolean;
  onLogin: () => void;
  onRetry: () => void;
}) {
  const checking = state === "checking";
  const expired = state === "expired";
  return <main className="auth-screen"><section className="auth-card" aria-labelledby="auth-title">
    <div className="auth-brand"><span className="brand-mark"><Code2 size={19} /></span><span className="brand-name">pocket<span>code</span></span></div>
    <div className="auth-icon"><Github size={24} /></div>
    <p className="auth-eyebrow">{expired ? "SESSION EXPIRED" : "YOUR CODING WORKSPACE"}</p>
    <h1 id="auth-title">{checking ? "Checking your session" : expired ? "Sign in again" : "Welcome to PocketCode"}</h1>
    <p className="auth-description">{checking ? "Restoring your secure PocketCode session." : expired ? "Your session has expired. Sign in with GitHub to continue." : "Continue with your GitHub account to open your workspace."}</p>
    {notice && <p className="auth-notice" role="status">{notice}</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {checking ? <div className="auth-loading" role="status"><LoaderCircle size={17} className="spin" /> Verifying session</div> : <div className="auth-actions">
      {state === "error" && <button className="auth-retry" onClick={onRetry}>Retry session check</button>}
      <button className="github-login" onClick={onLogin} disabled={loginStarting}>
        {loginStarting ? <LoaderCircle size={17} className="spin" /> : <Github size={17} />}
        <span>{loginStarting ? "Connecting to GitHub…" : "Continue with GitHub"}</span>
      </button>
    </div>}
    <p className="auth-footnote"><ShieldCheck size={13} /> GitHub credentials stay on the PocketCode server.</p>
  </section></main>;
}

function WorkspaceApp(props: {
  authUser: AuthUser;
  authNotice: string;
  activeSection: "Workspace" | "Files" | "Settings";
  setActiveSection: (value: "Workspace" | "Files" | "Settings") => void;
  drawerOpen: boolean;
  setDrawerOpen: (value: boolean) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
  loggingOut: boolean;
  onLogout: () => void;
  onSessionExpired: () => void;
}) {
  const { authUser, activeSection, setActiveSection, onSessionExpired } = props;
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(true);
  const [repositoryError, setRepositoryError] = useState("");
  const [repositoryErrorCode, setRepositoryErrorCode] = useState("");
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [branchConnection, setBranchConnection] = useState<RepositoryBranchConnection | null>(null);
  const [branchState, setBranchState] = useState<"loading" | "confirmation" | "provisioning" | "ready" | "error">("loading");
  const [branchError, setBranchError] = useState("");
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState("");
  const [treePath, setTreePath] = useState("");
  const [selectedRef, setSelectedRef] = useState("");
  const [fileSearch, setFileSearch] = useState("");
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const [providerSummary, setProviderSummary] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [agentSessionId, setAgentSessionId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [sending, setSending] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [toolCalls, setToolCalls] = useState<AgentToolCall[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [decidingProposal, setDecidingProposal] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const selectedRepository = repositories.find((repo) => repo.id === selectedRepositoryId) ?? null;

  const loadRepositories = useCallback(async () => {
    setRepositoriesLoading(true);
    setRepositoryError("");
    setRepositoryErrorCode("");
    try {
      const value = await requestJson<{ repositories: Repository[] }>("/api/github/repositories");
      if (!value || !Array.isArray(value.repositories)) throw new Error("invalid_repository_response");
      setRepositories(value.repositories);
      setSelectedRepositoryId((selected) => selected && value.repositories.some((repo) => repo.id === selected)
        ? selected : "");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else {
        setRepositoryError(apiMessage(error, "repositories"));
        setRepositoryErrorCode(error instanceof ApiError ? error.code : "");
      }
    } finally { setRepositoriesLoading(false); }
  }, [onSessionExpired]);

  const loadProviderState = useCallback(async () => {
    try {
      const value = await requestJson<{
        selected: { providerId: string; modelId: string } | null;
        credentials: Array<{ providerId: string; configured: boolean }>;
      }>("/api/ai/configuration");
      const ready = Boolean(value.selected?.providerId && value.selected.modelId &&
        value.credentials.some((item) => item.providerId === value.selected?.providerId && item.configured));
      setProviderReady(ready);
      setProviderSummary(ready ? `${value.selected?.providerId} · ${value.selected?.modelId}` : "Provider setup required");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else { setProviderReady(false); setProviderSummary("Provider configuration unavailable"); }
    }
  }, [onSessionExpired]);

  useEffect(() => { void loadRepositories(); }, [loadRepositories]);
  useEffect(() => { void loadProviderState(); }, [activeSection, loadProviderState]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, agentEvents]);

  const workspaceFilesMode = Boolean(workspaceId);
  const loadTree = useCallback(async (repo: Repository, path = "", ref = "") => {
    setTreeLoading(true);
    setTreeError("");
    setTreePath(path);
    setSelectedFile(null);
    setFileError("");
    try {
      if (workspaceFilesMode && workspaceId) {
        const value = await requestJson<{ files: Array<{ path: string; size: number }> }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files`);
        const prefix = path ? `${path}/` : "";
        const entries = new Map<string, TreeEntry>();
        for (const file of value.files) {
          if (!file.path.startsWith(prefix)) continue;
          const rest = path ? file.path.slice(prefix.length) : file.path;
          if (!rest) continue;
          const slash = rest.indexOf("/");
          if (slash >= 0) {
            const name = rest.slice(0, slash);
            entries.set(name, { name, path: `${prefix}${name}`, type: "directory" });
          } else entries.set(rest, { name: rest, path: file.path, type: "file", size: file.size });
        }
        setTreeEntries([...entries.values()].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
      } else {
        const query = new URLSearchParams();
        if (path) query.set("path", path);
        if (ref) query.set("ref", ref);
        const suffix = query.size ? `?${query}` : "";
        const value = await requestJson<{ entries: TreeEntry[]; ref?: string | null }>(
          `/api/github/repositories/${encodeURIComponent(repo.id)}/tree${suffix}`,
        );
        if (!Array.isArray(value.entries)) throw new Error("invalid_tree_response");
        setTreeEntries(value.entries);
        setSelectedRef(value.ref ?? repo.defaultBranch ?? "");
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setTreeError(apiMessage(error, "files"));
      setTreeEntries([]);
    } finally { setTreeLoading(false); }
  }, [onSessionExpired, workspaceFilesMode, workspaceId]);

  useEffect(() => {
    if (selectedRepository) {
      setTreePath("");
      void loadTree(selectedRepository, "", branchState === "ready" ? branchConnection?.featureBranch ?? "" : "");
    } else {
      setTreeEntries([]);
      setTreePath("");
      setSelectedFile(null);
      setSelectedRef("");
    }
  }, [selectedRepositoryId, selectedRepository, loadTree, branchState, branchConnection]);

  useEffect(() => {
    if (!selectedRepository) {
      setBranchConnection(null);
      setBranchState("loading");
      setBranchError("");
      return;
    }
    let cancelled = false;
    setBranchConnection(null);
    setBranchState("loading");
    setBranchError("");
    void requestJson<{ connection: RepositoryBranchConnection | null }>(
      `/api/repository-connections/${encodeURIComponent(selectedRepository.id)}`,
    ).then(({ connection }) => {
      if (cancelled) return;
      setBranchConnection(connection);
      if (!connection) {
        setBranchState("confirmation");
        setSelectedRef(selectedRepository.defaultBranch ?? "");
        return;
      }
      if (connection.status === "active") {
        setBranchState("ready");
        setSelectedRef(connection.featureBranch);
      } else {
        setBranchState("error");
        setBranchError(connection.status === "branch_missing"
          ? "The saved PocketCode branch no longer exists. It was not recreated; recovery is required."
          : connection.status === "access_lost"
            ? "The saved GitHub installation no longer has access to this repository."
            : connection.status === "branch_collision"
              ? "The saved branch could not be safely associated. Contact support before continuing."
              : "Branch setup needs recovery. PocketCode will not adopt or recreate a branch automatically.");
      }
    }).catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else {
        setBranchState("error");
        setBranchError("PocketCode could not verify this repository's persistent branch. Retry the selection.");
      }
    });
    return () => { cancelled = true; };
  }, [selectedRepository, onSessionExpired]);

  const openFile = async (entry: TreeEntry) => {
    if (!selectedRepository) return;
    setFileLoading(true);
    setFileError("");
    setSelectedFilePath(entry.path);
    setSelectedFile(null);
    try {
      let value: FileContent;
      if (workspaceFilesMode && workspaceId) {
        value = await requestJson<FileContent>(`/api/workspaces/${encodeURIComponent(workspaceId)}/file?${new URLSearchParams({ path: entry.path })}`);
      } else {
        const query = new URLSearchParams({ path: entry.path });
        if (selectedRef) query.set("ref", selectedRef);
        value = await requestJson<FileContent>(`/api/github/repositories/${encodeURIComponent(selectedRepository.id)}/file?${query}`);
      }
      setSelectedFile(value);
      setActiveSection("Files");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setFileError(apiMessage(error, "files"));
    } finally { setFileLoading(false); }
  };

  const chooseRepository = (id: string) => {
    if (sending) return;
    setSelectedRepositoryId(id);
    setBranchConnection(null);
    setBranchState("loading");
    setBranchError("");
    setTreePath("");
    setSelectedFile(null);
    setAgentSessionId("");
    setWorkspaceId("");
    setMessages([]);
    setProposals([]);
    setAgentEvents([]);
    setToolCalls([]);
    setAgentError("");
    setSelectedRef("");
  };

  const confirmRepository = async () => {
    if (!selectedRepository || branchState === "provisioning") return;
    setBranchState("provisioning");
    setBranchError("");
    try {
      const value = await requestJson<{ connection: RepositoryBranchConnection }>("/api/repository-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": authUser.csrfToken },
        body: JSON.stringify({ repositoryId: selectedRepository.id, confirmed: true }),
      });
      setBranchConnection(value.connection);
      if (value.connection.status !== "active") {
        setBranchState("error");
        setBranchError("Branch setup needs recovery. PocketCode will not adopt or recreate a branch automatically.");
        return;
      }
      setBranchState("ready");
      setSelectedRef(value.connection.featureBranch);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else {
        setBranchState("error");
        setBranchError(error instanceof ApiError && error.code === "branch_name_collision"
          ? "A branch with PocketCode's reserved name already exists. It was not adopted or overwritten."
          : "PocketCode could not create or verify the persistent branch. Retry or resolve the reported branch state.");
      }
    }
  };

  const refreshEvents = useCallback(async (sessionId: string) => {
    try {
      const value = await requestJson<{ events: AgentEvent[] }>(`/api/agent/sessions/${encodeURIComponent(sessionId)}/events`);
      const recent = value.events.slice(-20);
      setAgentEvents(recent);
      setToolCalls(value.events.filter((item) => item.type === "tool" && item.data?.name).map((item) => ({
        name: item.data!.name!,
        success: item.data?.success === true,
        ...(item.data?.error ? { error: item.data.error } : {}),
      })));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
    }
  }, [onSessionExpired]);

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const message = draft.trim();
    if (!message || sending || !selectedRepository || branchState !== "ready" || !branchConnection ||
        branchConnection.status !== "active" || providerReady !== true) return;
    setDraft("");
    if (composerRef.current) composerRef.current.style.height = "auto";
    setMessages((items) => [...items, {
      id: crypto.randomUUID(), role: "user", text: message,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }]);
    setSending(true);
    setAgentError("");
    setAgentEvents([]);
    setToolCalls([]);
    try {
      let activeWorkspaceId = workspaceId;
      if (!activeWorkspaceId) {
        const created = await requestJson<{ id: string }>("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-csrf-token": authUser.csrfToken },
          body: JSON.stringify({ repositoryId: selectedRepository.id, branchRef: branchConnection.featureBranch }),
        });
        if (!created.id) throw new Error("workspace_response_invalid");
        activeWorkspaceId = created.id;
        setWorkspaceId(created.id);
      }
      let activeSessionId = agentSessionId;
      if (!activeSessionId) {
        const created = await requestJson<{ id: string }>("/api/agent/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-csrf-token": authUser.csrfToken },
          body: JSON.stringify({ workspaceId: activeWorkspaceId }),
        });
        if (!created.id) throw new Error("agent_session_response_invalid");
        activeSessionId = created.id;
        setAgentSessionId(created.id);
      }
      const poll = window.setInterval(() => { void refreshEvents(activeSessionId); }, 1000);
      try {
        const response = await requestJson<{ message: string; toolCalls: AgentToolCall[]; proposals: Proposal[] }>(
          `/api/agent/sessions/${encodeURIComponent(activeSessionId)}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-csrf-token": authUser.csrfToken },
            body: JSON.stringify({ message }),
          },
        );
        setToolCalls(response.toolCalls ?? []);
        setProposals(response.proposals ?? []);
        setMessages((items) => [...items, {
          id: crypto.randomUUID(), role: "assistant", text: response.message || "The agent completed without a text response.",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        }]);
        await refreshEvents(activeSessionId);
      } finally { window.clearInterval(poll); }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setAgentError(apiMessage(error, error instanceof ApiError && error.code.includes("workspace") ? "workspace" : "agent"));
    } finally { setSending(false); }
  };

  const cancelRun = async () => {
    if (!agentSessionId) return;
    try {
      await requestJson<void>(`/api/agent/sessions/${encodeURIComponent(agentSessionId)}/cancel`, {
        method: "POST",
        headers: { "x-csrf-token": authUser.csrfToken },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setAgentError("The agent could not be cancelled. It may have already finished.");
    }
  };

  const decideProposal = async (proposal: Proposal, action: "approve" | "reject") => {
    if (!workspaceId) return;
    setDecidingProposal(proposal.id);
    setAgentError("");
    try {
      await requestJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/changes/${encodeURIComponent(proposal.id)}/${action}`, {
        method: "POST",
        headers: { "x-csrf-token": authUser.csrfToken },
      });
      setProposals((items) => items.map((item) => item.id === proposal.id ? { ...item, status: action === "approve" ? "approved" : "rejected" } : item));
      if (selectedRepository) await loadTree(selectedRepository, treePath, selectedRef);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setAgentError("The proposal decision failed. Refresh the workspace and review its status.");
    } finally { setDecidingProposal(""); }
  };

  const filteredEntries = useMemo(() => treeEntries.filter((entry) => entry.name.toLowerCase().includes(fileSearch.toLowerCase())), [treeEntries, fileSearch]);
  const goUp = () => {
    if (!selectedRepository || !treePath) return;
    const parent = treePath.split("/").slice(0, -1).join("/");
    void loadTree(selectedRepository, parent, selectedRef);
  };
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  };

  return <div className={`product-shell ${props.drawerOpen ? "drawer-open" : ""}`}>
    {props.drawerOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => props.setDrawerOpen(false)} />}
    <aside className={`product-sidebar ${props.sidebarCollapsed ? "sidebar-mini" : ""}`}>
      <div className="product-brand">
        <span className="brand-mark"><Code2 size={17} strokeWidth={2.5} /></span>
        {!props.sidebarCollapsed && <><span className="brand-name">pocket<span>code</span></span><button className="icon-button mobile-close" onClick={() => props.setDrawerOpen(false)} aria-label="Close menu"><X size={17} /></button></>}
      </div>
      <nav className="primary-nav" aria-label="Main navigation">
        <NavButton active={activeSection === "Workspace"} icon={<MessageSquare size={16} />} label="Workspace" onClick={() => { setActiveSection("Workspace"); props.setDrawerOpen(false); }} collapsed={props.sidebarCollapsed} />
        <NavButton active={activeSection === "Files"} icon={<Folder size={16} />} label="Files" onClick={() => { setActiveSection("Files"); props.setDrawerOpen(false); }} collapsed={props.sidebarCollapsed} />
        <NavButton active={activeSection === "Settings"} icon={<Settings2 size={16} />} label="Settings" onClick={() => { setActiveSection("Settings"); props.setDrawerOpen(false); }} collapsed={props.sidebarCollapsed} />
      </nav>
      {activeSection !== "Settings" && !props.sidebarCollapsed && <div className="repository-browser">
        <div className="sidebar-section-heading"><span>GITHUB REPOSITORY</span><button className="icon-button small-icon" onClick={() => void loadRepositories()} disabled={repositoriesLoading} aria-label="Refresh repositories">{repositoriesLoading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}</button></div>
        {repositoryError && <div className="inline-error" role="alert"><span>{repositoryError}</span>
          {repositoryErrorCode === "github_installation_required" && <a href="/api/github/install">Install GitHub App</a>}
          {repositoryErrorCode !== "github_installation_required" && <button onClick={() => void loadRepositories()}>Retry</button>}
        </div>}
        {repositoriesLoading ? <div className="sidebar-state"><LoaderCircle size={15} className="spin" /> Loading repositories</div> :
          repositories.length === 0 ? <div className="sidebar-state">{repositoryError ? "Unable to load repositories." : "No repositories are available to this GitHub App."}</div> :
          <label className="repository-select-wrap"><span className="sr-only">Select GitHub repository</span>
            <select value={selectedRepositoryId} onChange={(event) => chooseRepository(event.target.value)}>
              <option value="">Choose a repository…</option>
              {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}
            </select><ChevronDown size={14} aria-hidden="true" />
          </label>}
        {selectedRepository && <>
          <div className="repository-context"><Github size={13} /><span title={selectedRepository.fullName}>{selectedRepository.fullName}</span></div>
          <div className="branch-context"><span className="branch-icon">⑂</span><span>{selectedRef || selectedRepository.defaultBranch || "Default branch"}</span><span className="branch-note">{branchState === "ready" ? "PocketCode" : "read-only"}</span></div>
          {branchState === "loading" && <div className="sidebar-state"><LoaderCircle size={14} className="spin" /> Checking persistent branch</div>}
          {branchState === "confirmation" && <div className="branch-confirmation">
            <p>Confirm <strong>{selectedRepository.fullName}</strong> to create one persistent PocketCode branch from <code>{selectedRepository.defaultBranch ?? "the default branch"}</code>.</p>
            <button onClick={() => void confirmRepository()} disabled={!selectedRepository.defaultBranch}>Confirm repository</button>
          </div>}
          {branchState === "provisioning" && <div className="sidebar-state"><LoaderCircle size={14} className="spin" /> Creating persistent branch</div>}
          {branchState === "error" && <div className="inline-error" role="alert">{branchError}</div>}
          <div className="tree-toolbar">
            <span>FILES</span>
            <label className="file-search"><Search size={13} /><input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="Filter files" aria-label="Filter current folder files" /></label>
          </div>
          {treePath && <button className="tree-up" onClick={goUp}><ArrowLeft size={13} /> <span>{treePath}</span></button>}
          {treeError && <div className="inline-error" role="alert"><span>{treeError}</span><button onClick={() => void loadTree(selectedRepository, treePath, selectedRef)}>Retry</button></div>}
          {treeLoading ? <div className="sidebar-state"><LoaderCircle size={15} className="spin" /> Loading files</div> :
            <div className="tree-entries">
              {filteredEntries.map((entry) => <button className="tree-entry" key={entry.path} title={entry.path}
                onClick={() => entry.type === "directory" ? void loadTree(selectedRepository, entry.path, selectedRef) : void openFile(entry)}>
                {entry.type === "directory" ? <Folder size={14} className="folder-icon" /> : <FileIconForPath path={entry.path} />}
                <span>{entry.name}</span>
              </button>)}
              {!treeError && filteredEntries.length === 0 && <p className="tree-empty">{fileSearch ? "No matching files." : "This folder is empty."}</p>}
            </div>}
        </>}
        {!selectedRepository && repositories.length > 0 && !repositoriesLoading && <div className="sidebar-state">Choose a repository to browse its files.</div>}
      </div>}
      <div className="sidebar-account">
        {!props.sidebarCollapsed && <div className="account-card"><div className="user-avatar">{authUser.githubUsername.slice(0, 1).toUpperCase()}</div><div className="account-copy"><strong>{authUser.githubUsername}</strong><span>GitHub account</span></div>
          <button className="account-logout" onClick={props.onLogout} disabled={props.loggingOut} aria-label="Sign out">{props.loggingOut ? <LoaderCircle size={15} className="spin" /> : <LogOut size={15} />}</button>
        </div>}
        {props.sidebarCollapsed && <button className="user-avatar collapsed-avatar" onClick={props.onLogout} aria-label="Sign out">{authUser.githubUsername.slice(0, 1).toUpperCase()}</button>}
      </div>
    </aside>
    <main className="product-main">
      <header className="product-topbar">
        <div className="topbar-leading">
          <button className="icon-button mobile-menu-button" onClick={() => props.setDrawerOpen(true)} aria-label="Open menu"><Menu size={18} /></button>
          <button className="icon-button collapse-button" onClick={() => props.setSidebarCollapsed(!props.sidebarCollapsed)} aria-label={props.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>{props.sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
          <div className="topbar-title"><span className="crumb-muted">PocketCode</span><ChevronRight size={14} /><strong>{activeSection === "Settings" ? "AI Providers" : selectedRepository?.name ?? activeSection}</strong></div>
        </div>
        <div className="topbar-trailing">
          {selectedRepository && <div className="topbar-repo"><Github size={14} /><span>{selectedRepository.fullName}</span><ChevronDown size={13} /></div>}
          <div className="connection-indicator"><span className="connection-dot" /> Connected</div>
          <div className="user-avatar topbar-avatar" title={authUser.githubUsername}>{authUser.githubUsername.slice(0, 1).toUpperCase()}</div>
        </div>
      </header>
      {props.authNotice && <p className="workspace-notice" role="status">{props.authNotice}</p>}
      {activeSection === "Settings" ? <ProviderSettings csrfToken={authUser.csrfToken} onSessionExpired={onSessionExpired} /> :
        activeSection === "Files" ? <div className="files-page-content">
          <MobileFileExplorer repository={selectedRepository} entries={filteredEntries} path={treePath} loading={treeLoading} error={treeError}
            onNavigate={(path) => selectedRepository && void loadTree(selectedRepository, path, selectedRef)} onOpenFile={(entry) => void openFile(entry)} />
          <FileViewer selectedFile={selectedFile} loading={fileLoading} error={fileError}
            onRetry={() => selectedFilePath && void openFile({ name: selectedFilePath.split("/").at(-1) ?? selectedFilePath, path: selectedFilePath, type: "file" })}
            repository={selectedRepository} selectedRef={selectedRef} />
        </div> :
          <section className="chat-workspace">
            <div className="chat-header">
              <div><p className="eyebrow-label">AI WORKSPACE</p><h1>{selectedRepository ? `Working in ${selectedRepository.name}` : "Your coding workspace"}</h1><p>{selectedRepository ? `Connected to ${selectedRepository.fullName}` : "Choose a GitHub repository to start exploring with PocketCode."}</p></div>
              {selectedRepository && <span className="header-branch"><span>⑂</span>{selectedRef || selectedRepository.defaultBranch || "Default branch"}</span>}
            </div>
            <div className="chat-body">
              {messages.length === 0 ? <div className="chat-welcome">
                <div className="welcome-icon"><Sparkles size={21} /></div>
                <h2>{selectedRepository ? "Ask about this repository" : "Start with a repository"}</h2>
                <p>{selectedRepository ? "PocketCode creates an isolated workspace from the selected branch before sending your request." : "Select one of your connected GitHub repositories from the sidebar. No sample or placeholder projects are shown."}</p>
                {selectedRepository && <div className="welcome-suggestions">
                  <button onClick={() => setDraft("Explain the structure of this repository.")}><Code2 size={15} /><span>Explain the repository structure</span><ChevronRight size={14} /></button>
                  <button onClick={() => setDraft("Review this codebase and identify a focused improvement.")}><ShieldCheck size={15} /><span>Find a focused improvement</span><ChevronRight size={14} /></button>
                </div>}
                {selectedRepository && !selectedRepository.defaultBranch && <p className="provider-warning" role="status">This repository does not report a default branch, so PocketCode cannot create a snapshot yet.</p>}
              </div> : <div className="message-list">
                {messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}>
                  <div className={`message-avatar ${message.role === "assistant" ? "assistant" : ""}`}>{message.role === "assistant" ? <Sparkles size={15} /> : authUser.githubUsername.slice(0, 1).toUpperCase()}</div>
                  <div className="message-content"><div className="message-meta"><strong>{message.role === "assistant" ? "PocketCode" : "You"}</strong><time>{message.time}</time></div><p>{message.text}</p></div>
                </article>)}
                {sending && <div className="agent-running">
                  <div className="message-avatar assistant"><Sparkles size={15} /></div>
                  <div className="running-content"><div className="running-title"><LoaderCircle size={14} className="spin" /> PocketCode is working</div>
                    <div className="activity-list">{agentEvents.slice(-5).map((item) => <div key={item.id} className="activity-item"><span className="activity-dot" />{item.type === "tool" ? `${item.data?.name ?? "Tool"} ${item.data?.success ? "completed" : item.data?.error ? "could not complete" : "running"}` : item.type === "progress" ? "Preparing the model request" : item.type === "complete" ? "Finishing response" : item.type === "error" ? "The run encountered an error" : item.type}</div>)}</div>
                  </div>
                </div>}
                <div ref={endRef} />
              </div>}
              {agentError && <div className="agent-error" role="alert"><CircleAlert size={16} /><span>{agentError}</span></div>}
              {toolCalls.length > 0 && <div className="tool-summary" aria-label="Agent tool activity"><div className="tool-summary-title"><Check size={14} /> Repository activity</div>{toolCalls.map((tool, index) => <div key={`${tool.name}-${index}`} className="tool-summary-row"><Code2 size={13} /><span>{tool.name}</span>{tool.path && <code>{tool.path}</code>}<span className={tool.success ? "tool-ok" : "tool-failed"}>{tool.success ? "Done" : "Unavailable"}</span></div>)}</div>}
              {proposals.length > 0 && <section className="proposal-list" aria-label="Change proposals"><div className="proposal-heading"><h2>Proposed changes</h2><span>{proposals.filter((item) => item.status === "pending").length} awaiting review</span></div>
                {proposals.map((proposal) => <article className="proposal-card" key={proposal.id}>
                  <div className="proposal-topline"><FileCode2 size={15} /><strong>{proposal.path}</strong><span className={`proposal-status status-${proposal.status}`}>{proposal.status}</span></div>
                  <p>{proposal.operation.replace("_", " ")} · Applies only to this isolated workspace after approval.</p>
                  {proposal.diff && <pre>{proposal.diff}</pre>}
                  {proposal.status === "pending" && <div className="proposal-actions">
                    <button className="proposal-reject" onClick={() => void decideProposal(proposal, "reject")} disabled={Boolean(decidingProposal)}>{decidingProposal === proposal.id ? <LoaderCircle size={14} className="spin" /> : <X size={14} />} Reject</button>
                    <button className="proposal-approve" onClick={() => void decideProposal(proposal, "approve")} disabled={Boolean(decidingProposal)}>{decidingProposal === proposal.id ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />} Approve</button>
                  </div>}
                </article>)}
              </section>}
            </div>
            <div className="composer-wrap">
              {providerReady === false && <div className="provider-warning" role="status"><ShieldCheck size={15} /><span>{providerSummary === "Provider configuration unavailable" ? "Provider settings could not be verified." : "Configure an AI provider and credential before chatting."}</span><button onClick={() => setActiveSection("Settings")}>Open settings</button></div>}
              {providerReady === null && <div className="composer-loading"><LoaderCircle size={14} className="spin" /> Checking provider configuration</div>}
              <form className="message-composer" onSubmit={(event) => void sendMessage(event)}>
                <textarea ref={composerRef} value={draft} rows={1} maxLength={20_000} disabled={!selectedRepository || branchState !== "ready" || providerReady !== true || sending}
                  placeholder={selectedRepository ? branchState !== "ready" ? "Confirm the repository's persistent branch before chatting" : providerReady === true ? "Ask PocketCode about this repository…" : "Provider setup required to message the agent" : "Select a repository to begin"}
                  aria-label="Message PocketCode" onKeyDown={onComposerKeyDown}
                  onChange={(event) => { setDraft(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; }} />
                <div className="composer-bottom"><span><ShieldCheck size={12} /> Changes are proposals. Nothing is applied without approval.</span>
                  {sending ? <button className="cancel-button" type="button" onClick={() => void cancelRun()} disabled={!agentSessionId}><X size={14} /> Cancel run</button> :
                    <button className="send-button" type="submit" disabled={!draft.trim() || !selectedRepository || branchState !== "ready" || providerReady !== true} aria-label="Send message"><ArrowUp size={17} /></button>}
                </div>
              </form>
              {workspaceId && <p className="workspace-session-note">Isolated workspace active · {providerSummary}</p>}
            </div>
          </section>}
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <NavButton active={activeSection === "Workspace"} icon={<MessageSquare size={18} />} label="Workspace" onClick={() => setActiveSection("Workspace")} />
        <NavButton active={activeSection === "Files"} icon={<Folder size={18} />} label="Files" onClick={() => setActiveSection("Files")} />
        <NavButton active={activeSection === "Settings"} icon={<Settings2 size={18} />} label="Settings" onClick={() => setActiveSection("Settings")} />
      </nav>
    </main>
  </div>;
}

function NavButton({ active, icon, label, onClick, collapsed = false }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void; collapsed?: boolean }) {
  return <button className={`nav-button ${active ? "active" : ""} ${collapsed ? "collapsed" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined} title={collapsed ? label : undefined}>
    {icon}{!collapsed && <span>{label}</span>}
  </button>;
}

function FileIconForPath({ path }: { path: string }) {
  const ext = path.split(".").at(-1)?.toLowerCase();
  return ext && ["ts", "tsx", "js", "jsx", "py", "go", "rs", "java"].includes(ext)
    ? <FileCode2 size={14} className="code-file-icon" /> : <FileIcon size={14} className="plain-file-icon" />;
}

function MobileFileExplorer({ repository, entries, path, loading, error, onNavigate, onOpenFile }: {
  repository: Repository | null;
  entries: TreeEntry[];
  path: string;
  loading: boolean;
  error: string;
  onNavigate: (path: string) => void;
  onOpenFile: (entry: TreeEntry) => void;
}) {
  if (!repository) return null;
  return <section className="mobile-file-explorer" aria-label="Repository file browser">
    <h2>{repository.fullName}</h2>
    {path && <button className="tree-up" onClick={() => onNavigate(path.split("/").slice(0, -1).join("/"))}><ArrowLeft size={13} /><span>{path}</span></button>}
    {error && <div className="inline-error" role="alert"><span>{error}</span><button onClick={() => onNavigate(path)}>Retry</button></div>}
    {loading ? <div className="sidebar-state"><LoaderCircle size={14} className="spin" /> Loading files</div> :
      <div className="tree-entries">{entries.map((entry) => <button className="tree-entry" key={entry.path} onClick={() => entry.type === "directory" ? onNavigate(entry.path) : onOpenFile(entry)}>
        {entry.type === "directory" ? <Folder size={14} className="folder-icon" /> : <FileIconForPath path={entry.path} />}<span>{entry.name}</span>
      </button>)}{entries.length === 0 && !error && <p className="tree-empty">No files in this folder.</p>}</div>}
  </section>;
}

function FileViewer({ selectedFile, loading, error, onRetry, repository, selectedRef }: {
  selectedFile: FileContent | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  repository: Repository | null;
  selectedRef: string;
}) {
  const lines = selectedFile?.content.split("\n") ?? [];
  return <section className="file-view-page">
    <header className="file-view-heading"><div><p className="eyebrow-label">REPOSITORY FILES</p><h1>{selectedFile?.path ?? "File preview"}</h1><p>{repository ? `${repository.fullName} · ${selectedRef || repository.defaultBranch || "default branch"}` : "Choose a repository to browse files."}</p></div>
      {selectedFile && <span className="file-size">{selectedFile.size ?? new Blob([selectedFile.content]).size} bytes</span>}
    </header>
    {error && <div className="file-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button onClick={onRetry}>Retry</button></div>}
    {loading ? <div className="file-placeholder" role="status"><LoaderCircle size={18} className="spin" /> Loading file</div> :
      selectedFile ? <div className="code-viewer" aria-label={`Contents of ${selectedFile.path}`}><div className="code-viewer-toolbar"><FileIconForPath path={selectedFile.path} /><span>{selectedFile.path}</span><span className="read-only-label">Read only</span></div>
        <pre>{lines.map((line, index) => <code key={index}><span className="line-no">{index + 1}</span><span>{line || " "}</span></code>)}</pre>
      </div> : <div className="file-placeholder"><FileCode2 size={23} /><strong>Select a text file</strong><span>Choose a file from the repository sidebar to preview its contents.</span><button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><ArrowDown size={14} /> Browse repository</button></div>}
  </section>;
}

export default App;
