import { basename } from "node:path"

/** Shared by the core integration and final immutable policy. Keep the union of
 * their protections: adding a reader must not create a second path vocabulary. */
export function isSensitivePath(path: string, writing = false) {
  const normalized = path.toLowerCase().replaceAll("\\", "/")
  const name = basename(normalized)
  if (/\.env\.(?:example|sample|template)$/.test(name)) return false
  if (name === ".env" || name.startsWith(".env.")) return true
  if (!writing && name.endsWith(".pub")) return false

  const sensitiveDirectories = [
    "/.ssh/", "/.gnupg/", "/.aws/", "/.azure/", "/.kube/", "/.docker/",
    "/.config/gcloud/", "/.local/share/keyrings/", "/.password-store/", "/secrets/",
  ]
  if (sensitiveDirectories.some((segment) => normalized.includes(segment))) return true
  if (["/.ssh", "/.gnupg", "/.aws", "/.azure", "/.kube", "/.docker", "/secrets"].some((suffix) => normalized.endsWith(suffix))) return true
  if (/\/(?:proc\/[^/]+\/environ|etc\/(?:shadow|gshadow|sudoers))$/.test(normalized)) return true
  if (/\/\.git\/(?:config|credentials)$/.test(normalized)) return true
  if (/\/\.pi\/(?:auth|credentials)\.json$/.test(normalized)) return true
  if ([".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials.json", "auth.json"].includes(name)) return true
  // Preserve the core integration's legacy env/values filename protections.
  if (name.startsWith(".env") && /(local|dev|prod|stag|test)/.test(name)) return true
  if (name.startsWith("values") && /(dev|prod|stag|test)/.test(name)) return true
  if (/^(?:id_rsa|id_ed25519|id_ecdsa)/.test(name)) return true
  if (/\.(?:pem|key|p12|pfx|gpg|asc)$/.test(name)) return true
  if (/secret.*\.ya?ml$/.test(name)) return true
  if (/^(?:credentials?|service-account|gcp-key)(?:[._-].*)?\.ya?ml$/.test(name)) return true
  if (/^(?:service-account|gcp-key).*\.json$/.test(name)) return true
  return false
}

export function shellTokens(command: string) {
  return (command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|<>]+/g) ?? [])
    .map((token) => token.replace(/^['"]|['"]$/g, "").replace(/[),]+$/g, ""))
}

function heredocBodies(command: string) {
  const bodies: string[] = []
  // Quoted, unquoted, escaped and tab-stripping delimiters. Inspect every body,
  // not just Python's: shell/heredoc wrappers must not hide immutable operations.
  const headers = /(?:^|[^<])<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))[^\n]*\n/g
  for (const match of command.matchAll(headers)) {
    const delimiter = match[2] ?? match[3] ?? match[4]
    const start = match.index! + match[0].length
    const lines = command.slice(start).split("\n")
    const end = lines.findIndex((line) => (match[1] ? line.replace(/^\t+/, "") : line) === delimiter)
    // An incomplete heredoc is still inspected, never silently discarded.
    bodies.push(lines.slice(0, end < 0 ? undefined : end).join("\n"))
  }
  return bodies
}

export function commandInspectionVariants(command: string) {
  const variants = [command]
  const seen = new Set(variants)
  const add = (value: string) => {
    if (value && !seen.has(value) && variants.length < 16) {
      seen.add(value)
      variants.push(value)
    }
  }
  const addCode = (payload: string) => {
    add(payload)
    add(payload.replace(/[^A-Za-z0-9_./~*=$+!\\\-]+/g, " "))
  }

  for (let index = 0; index < variants.length && index < 16; index++) {
    for (const body of heredocBodies(variants[index])) addCode(body)
    const tokens = shellTokens(variants[index])
    for (let tokenIndex = 0; tokenIndex < tokens.length - 1; tokenIndex++) {
      const interpreter = basename(tokens[tokenIndex]).toLowerCase()
      const shell = /^(?:ba|da|a|z|k|fi)?sh$/.test(interpreter)
      const code = /^(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|ruby|perl|php|bun|deno)$/.test(interpreter)
      if (!shell && !code) continue

      for (let argumentIndex = tokenIndex + 1; argumentIndex < Math.min(tokens.length - 1, tokenIndex + 4); argumentIndex++) {
        const argument = tokens[argumentIndex]
        const executesText = shell ? /^-[^-]*c/.test(argument) : /^(?:-c|-e|-r|-p|--eval|--print)$/.test(argument)
        if (!executesText) continue
        const payload = tokens[argumentIndex + 1]
        if (code) addCode(payload)
        else add(payload)
        break
      }
    }
  }
  return variants
}

export function shellPathTokens(command: string) {
  const paths: string[] = []
  // Shell tokens alone miss Path('/project/.env'), open('.env'), assignments,
  // and nested quotes in -c/-e, here-strings or heredocs. Also scan literal path
  // fragments, independent of executable names, so new interpreters fail shut.
  // Keep complete shell tokens too, for quoted paths containing spaces.
  const embedded = command.match(/[A-Za-z0-9_./~*=$+!\\\-]+/g) ?? []
  for (const token of [...shellTokens(command), ...embedded]) {
    const value = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(token)?.[1] ?? token
    const literal = !/[\\'"`()]/.test(value)
    if (value.startsWith("/") || value.startsWith(".") || value.startsWith("~")
      || (literal && (value.includes("/") || isSensitivePath(`/${value}`, true)))) paths.push(value)
  }
  return [...new Set(paths)]
}
