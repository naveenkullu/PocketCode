import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, KeyRound, LoaderCircle, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react";

type Provider = { id: string; name: string };
type ProviderConfiguration = {
  selected: { providerId: string; modelId: string } | null;
  credentials: Array<{ providerId: string; configured: boolean }>;
};

const providerErrorMessage = (status: number) => {
  if (status === 400) return "The provider, model ID, or credential was rejected. Check the value and try again.";
  if (status === 403) return "This request could not pass security validation. Reload settings and try again.";
  if (status === 503) return "Secure credential storage is unavailable. Contact the PocketCode administrator.";
  return "The settings request failed. Please try again.";
};

export function ProviderSettings({ csrfToken, onSessionExpired }: {
  csrfToken: string;
  onSessionExpired: () => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configuration, setConfiguration] = useState<ProviderConfiguration | null>(null);
  const [providerId, setProviderId] = useState("groq");
  const [modelId, setModelId] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [deletingKey, setDeletingKey] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const keyInputRef = useRef<HTMLInputElement>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [providersResponse, configurationResponse] = await Promise.all([
        fetch("/api/ai/providers", { headers: { Accept: "application/json" }, credentials: "same-origin" }),
        fetch("/api/ai/configuration", { headers: { Accept: "application/json" }, credentials: "same-origin" }),
      ]);
      if (configurationResponse.status === 401) {
        onSessionExpired();
        return;
      }
      if (!providersResponse.ok || !configurationResponse.ok) {
        throw new Error(providerErrorMessage(!providersResponse.ok ? providersResponse.status : configurationResponse.status));
      }
      const providersData: unknown = await providersResponse.json();
      const configurationData: unknown = await configurationResponse.json();
      if (
        typeof providersData !== "object" || providersData === null || !("providers" in providersData) ||
        !Array.isArray(providersData.providers) ||
        !providersData.providers.every((item: unknown) =>
          typeof item === "object" && item !== null &&
          "id" in item && typeof item.id === "string" &&
          "name" in item && typeof item.name === "string")
      ) throw new Error("Provider information could not be read.");
      if (
        typeof configurationData !== "object" || configurationData === null ||
        !("selected" in configurationData) ||
        !("credentials" in configurationData) || !Array.isArray(configurationData.credentials) ||
        !configurationData.credentials.every((item: unknown) =>
          typeof item === "object" && item !== null &&
          "providerId" in item && typeof item.providerId === "string" &&
          "configured" in item && typeof item.configured === "boolean")
      ) throw new Error("Provider settings could not be read.");

      const selectedValue = configurationData.selected;
      if (selectedValue !== null && (
        typeof selectedValue !== "object" || !("providerId" in selectedValue) ||
        typeof selectedValue.providerId !== "string" || !("modelId" in selectedValue) ||
        typeof selectedValue.modelId !== "string"
      )) throw new Error("The saved provider configuration is invalid.");

      const parsedConfiguration = configurationData as ProviderConfiguration;
      setProviders(providersData.providers);
      setConfiguration(parsedConfiguration);
      setProviderId(parsedConfiguration.selected?.providerId ?? "groq");
      setModelId(parsedConfiguration.selected?.modelId ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Provider settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired]);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const credentialConfigured = configuration?.credentials.find((item) => item.providerId === providerId)?.configured ?? false;

  const saveCredential = async (event: FormEvent) => {
    event.preventDefault();
    const input = keyInputRef.current;
    const apiKey = input?.value ?? "";
    if (apiKey.length === 0 || apiKey.length > 8192 || apiKey.trim() !== apiKey || /[\0\r\n]/.test(apiKey)) {
      setError("Enter a valid API key without leading or trailing whitespace.");
      return;
    }

    setSavingKey(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/ai/credentials/${encodeURIComponent(providerId)}`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        credentials: "same-origin",
        body: JSON.stringify({ apiKey }),
      });
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      if (!response.ok) throw new Error(providerErrorMessage(response.status));
      const result: unknown = await response.json();
      if (
        typeof result !== "object" || result === null ||
        !("providerId" in result) || result.providerId !== providerId ||
        !("configured" in result) || result.configured !== true
      ) throw new Error("The credential could not be verified as saved.");
      setConfiguration((current) => current && ({
        ...current,
        credentials: current.credentials.map((item) =>
          item.providerId === providerId ? { ...item, configured: true } : item),
      }));
      setNotice("API key saved securely. It cannot be viewed here.");
      if (input) input.value = "";
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The API key could not be saved.");
    } finally {
      if (input) input.value = "";
      setSavingKey(false);
    }
  };

  const saveConfiguration = async (event: FormEvent) => {
    event.preventDefault();
    if (!providerId || modelId.trim() !== modelId || modelId.length === 0 || modelId.length > 200 || /[\0\r\n]/.test(modelId)) {
      setError("Enter a model ID of 1–200 characters with no surrounding whitespace or line breaks.");
      return;
    }
    setSavingModel(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/ai/configuration", {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        credentials: "same-origin",
        body: JSON.stringify({ providerId, modelId }),
      });
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      if (!response.ok) throw new Error(providerErrorMessage(response.status));
      const result: unknown = await response.json();
      if (
        typeof result !== "object" || result === null || !("selected" in result) ||
        typeof result.selected !== "object" || result.selected === null ||
        !("providerId" in result.selected) || result.selected.providerId !== providerId ||
        !("modelId" in result.selected) || result.selected.modelId !== modelId
      ) throw new Error("The provider configuration could not be verified as saved.");
      setConfiguration(result as ProviderConfiguration);
      setNotice("Provider and model saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The provider configuration could not be saved.");
    } finally {
      setSavingModel(false);
    }
  };

  const deleteCredential = async () => {
    setDeletingKey(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/ai/credentials/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
        headers: { Accept: "application/json", "x-csrf-token": csrfToken },
        credentials: "same-origin",
      });
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      if (!response.ok) throw new Error(providerErrorMessage(response.status));
      const result: unknown = await response.json();
      if (
        typeof result !== "object" || result === null ||
        !("providerId" in result) || result.providerId !== providerId ||
        !("configured" in result) || result.configured !== false
      ) throw new Error("The credential removal could not be verified.");
      setConfiguration((current) => current && ({
        ...current,
        credentials: current.credentials.map((item) =>
          item.providerId === providerId ? { ...item, configured: false } : item),
      }));
      setNotice("Saved API key removed.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The API key could not be removed.");
    } finally {
      setDeletingKey(false);
    }
  };

  return <section className="settings-page" aria-labelledby="provider-settings-title">
    <header className="settings-heading">
      <div>
        <p className="settings-eyebrow">SETTINGS</p>
        <h1 id="provider-settings-title">AI Providers</h1>
        <p>Configure your own provider credentials. Keys are encrypted by PocketCode and never shown after saving.</p>
      </div>
      <button className="settings-refresh" onClick={() => void loadSettings()} disabled={loading} aria-label="Reload provider settings">
        {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
        <span>Refresh</span>
      </button>
    </header>

    {error && <p className="settings-feedback settings-error" role="alert">{error}</p>}
    {notice && <p className="settings-feedback settings-success" role="status"><Check size={15} />{notice}</p>}

    {loading ? <div className="settings-loading" role="status"><LoaderCircle size={17} className="spin" /> Loading provider settings</div> : (
      <div className="provider-settings-card">
        <div className="provider-card-heading">
          <span className="provider-card-icon"><KeyRound size={18} /></span>
          <div><h2>Provider configuration</h2><p>Choose a provider and set a model ID supported by that provider.</p></div>
        </div>

        <label className="settings-label" htmlFor="ai-provider">Provider</label>
        <select id="ai-provider" className="settings-input" value={providerId} onChange={(event) => {
          setProviderId(event.target.value);
          setModelId(configuration?.selected?.providerId === event.target.value ? configuration.selected.modelId : "");
          setNotice("");
          setError("");
          if (keyInputRef.current) keyInputRef.current.value = "";
        }}>
          {providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
        </select>

        <div className="credential-status" role="status">
          <span className={`credential-status-dot ${credentialConfigured ? "credential-configured" : ""}`} />
          <span>{credentialConfigured ? "API key configured" : "No API key saved for this provider"}</span>
          {credentialConfigured && <ShieldCheck size={15} />}
        </div>

        <form className="settings-form" onSubmit={(event) => void saveCredential(event)}>
          <label className="settings-label" htmlFor="ai-api-key">{credentialConfigured ? "Replace API key" : "API key"}</label>
          <input
            ref={keyInputRef}
            id="ai-api-key"
            className="settings-input"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={8192}
            placeholder={credentialConfigured ? "Enter a new key to replace the saved key" : "Paste your provider API key"}
            aria-describedby="ai-key-help"
            disabled={savingKey || deletingKey}
          />
          <p id="ai-key-help" className="settings-help">The saved key is never returned or displayed. It is sent only to PocketCode’s encrypted credential endpoint.</p>
          <div className="settings-button-row">
            <button type="submit" className="settings-primary-button" disabled={savingKey || loading}>
              {savingKey ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
              <span>{savingKey ? "Saving key" : credentialConfigured ? "Replace key" : "Save key"}</span>
            </button>
            {credentialConfigured && <button type="button" className="settings-danger-button" onClick={() => void deleteCredential()} disabled={deletingKey || savingKey}>
              {deletingKey ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
              <span>{deletingKey ? "Removing key" : "Remove key"}</span>
            </button>}
          </div>
        </form>

        <form className="settings-form model-settings-form" onSubmit={(event) => void saveConfiguration(event)}>
          <label className="settings-label" htmlFor="ai-model-id">Model ID</label>
          <input
            id="ai-model-id"
            className="settings-input"
            type="text"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder="Enter the model ID from your provider"
            aria-describedby="ai-model-help"
          />
          <p id="ai-model-help" className="settings-help">Model IDs are provider-specific; PocketCode does not assume or suggest a model catalog.</p>
          <button type="submit" className="settings-primary-button" disabled={savingModel || loading}>
            {savingModel ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
            <span>{savingModel ? "Saving configuration" : "Save provider and model"}</span>
          </button>
        </form>
      </div>
    )}
    <p className="settings-security-note"><ShieldCheck size={14} /> No AI request is made when saving provider settings.</p>
  </section>;
}
