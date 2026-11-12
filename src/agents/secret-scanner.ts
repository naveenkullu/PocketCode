import type { Message } from "@cline/llms";

export type SecretKind =
  | "private-key"
  | "database-credential"
  | "bearer-token"
  | "jwt"
  | "github-token"
  | "aws-access-key"
  | "google-api-key"
  | "cloud-provider-token"
  | "credential-assignment";

export interface SecretScanResult {
  content: string;
  findings: SecretKind[];
}

interface Detector {
  kind: SecretKind;
  pattern: RegExp;
  replace?: (...groups: string[]) => string | null;
}

const detectors: Detector[] = [
  {
    kind: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    kind: "database-credential",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s/@:]+:[^\s/@]+@[^\s"'<>]+/gi,
  },
  {
    kind: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi,
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  {
    kind: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    kind: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    kind: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  },
  {
    kind: "cloud-provider-token",
    pattern:
      /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|rk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    kind: "credential-assignment",
    pattern:
      /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|(?:aws[_-]?)?secret(?:[_-]?(?:key|access[_-]?key))?|password|passwd|pwd|credentials?|private[_-]?key|account[_-]?key)\b\s*[:=]\s*)(["'])([^"'\r\n]{8,})\2/gi,
    replace: (whole, prefix, quote, value) => {
      if (isPlaceholder(value)) return whole;
      return `${prefix}${quote}[REDACTED:credential-assignment]${quote}`;
    },
  },
  {
    kind: "credential-assignment",
    pattern:
      /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|(?:aws[_-]?)?secret(?:[_-]?(?:key|access[_-]?key))?|password|passwd|pwd|credentials?|private[_-]?key|account[_-]?key)\b\s*[:=]\s*)([^\s,;#"'`]{16,})/gi,
    replace: (whole, prefix, value) =>
      isPlaceholder(value) ? whole : `${prefix}[REDACTED:credential-assignment]`,
  },
];

function isPlaceholder(value: string): boolean {
  return /^(?:your[_ -].*|<[^>]+>|(?:replace|insert|enter|your)[_-]?[_a-z-]*(?:here)?|change[_-]?me|(?:example|sample|placeholder)(?:[_-].*)?|process\.env\.[A-Z0-9_]+)$/i.test(
    value.trim(),
  );
}

function marker(kind: SecretKind): string {
  return `[REDACTED:${kind}]`;
}

function redactLiteralSecrets(content: string, literalSecrets: readonly string[]): string {
  let redacted = content;
  for (const secret of literalSecrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED:configured-credential]");
  }
  return redacted;
}

export function scanAndRedactSecrets(content: string): SecretScanResult {
  const findings = new Set<SecretKind>();
  let redacted = content;

  for (const detector of detectors) {
    redacted = redacted.replace(detector.pattern, (...args: unknown[]) => {
      const whole = String(args[0]);
      const replacement = detector.replace?.(
        whole,
        ...args.slice(1, -2).map((value) => String(value)),
      );
      if (replacement === whole) return whole;
      findings.add(detector.kind);
      return replacement ?? marker(detector.kind);
    });
  }

  return { content: redacted, findings: [...findings] };
}

function redactUnknown(
  value: unknown,
  findings: Set<SecretKind>,
  literalSecrets: readonly string[],
  depth = 0,
): unknown {
  if (depth >= 16) return "[TRUNCATED]";
  if (typeof value === "string") {
    const result = scanAndRedactSecrets(value);
    result.findings.forEach((finding) => findings.add(finding));
    return redactLiteralSecrets(result.content, literalSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, findings, literalSecrets, depth + 1));
  }
  if (typeof value !== "object" || value === null) return value;

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    const safeKey = scanAndRedactSecrets(key);
    safeKey.findings.forEach((finding) => findings.add(finding));
    output[redactLiteralSecrets(safeKey.content, literalSecrets)] = redactUnknown(
      child,
      findings,
      literalSecrets,
      depth + 1,
    );
  }
  return output;
}

export function redactProviderMessages(
  messages: Message[],
  literalSecrets: readonly string[] = [],
): Message[] {
  const findings = new Set<SecretKind>();
  return redactUnknown(messages, findings, literalSecrets) as Message[];
}

export function containsDetectedSecret(content: string): boolean {
  return scanAndRedactSecrets(content).findings.length > 0;
}
