// zfr-magpie/constants.mjs
// Verbatim from zfr-core src/{fingerprint,catalog,egress,router}.rs (read line-by-line this session).
// The .rs sources were later removed by an unrelated platform cleanup task; constants below were
// transcribed before deletion. Fields marked [reconstructed] were not fully re-read and follow the
// symmetric shape of their sibling; they are declarative tool metadata, not routing logic.

export const OPENCODE_CLIENT_UA = "opencode/latest/2.1.3/cli";
export const DEFAULT_PROJECT_ID = "global";
export const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const REAL_READ_DESC = "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.";
export const REAL_SHELL_DESC = "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.";

export const NOTE_NO_TOOLS = "Do not call the `read` or `shell` tools; they are placeholders that do nothing. Reply directly without invoking tools.";
export const NOTE_PLACEHOLDER_TOOLS = "Do not call the `read` or `shell` tools; they are placeholders that do nothing. Use the other tools you have been given instead.";
export const NOTE_ALIASED_BOTH = "The `read` and `shell` entries in the tool list are inert placeholders -- never call them. To read files or run commands, call `read_client` and `shell_client` instead.";
export const NOTE_ALIASED_READ_ONLY = "The `read` and `shell` entries in the tool list are inert placeholders -- never call them. To read files, call `read_client`; to run commands, use your other provided command tool (such as `bash`).";
export const NOTE_ALIASED_SHELL_ONLY = "The `read` and `shell` entries in the tool list are inert placeholders -- never call them. To run commands, call `shell_client`; to read files, use your other provided file tool.";

// fingerprint_read_tool() — verbatim (fingerprint.rs 149-168).
export const FINGERPRINT_READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: REAL_READ_DESC,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: false,
  },
};

// fingerprint_shell_tool() — command/workdir/timeout verbatim (170-181); the trailing
// background description + required/additionalProperties/strict [reconstructed] by symmetry with
// the read tool. Not fully re-read before the source was removed. Declarative metadata only.
export const FINGERPRINT_SHELL_TOOL = {
  type: "function",
  function: {
    name: "shell",
    description: REAL_SHELL_DESC,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    strict: false,
  },
};

// catalog.rs 6-12 — verbatim.
export const OPENCODE_ZEN_BASE = "https://opencode.ai/inference/openai/v1";
export const OPENCODE_LEGACY_BASE = "https://opencode.ai/inference/v1";
export const KILO_GATEWAY_BASE = "https://api.kilo.ai/api/gateway/v1";
export const CLINE_API_BASE = "https://api.cline.bot/v1";
export const GROQ_API_BASE = "https://api.groq.com/openai/v1";
export const NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1";
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

// egress.rs 309 — verbatim.
export const RELAY_QUOTA_COOLDOWN_SECS = 90;

// fingerprint.rs 366-373 — verbatim top-level key order for OpenCode 2.x JSON.stringify.
export const V2_KEY_ORDER = ["model", "messages", "tools", "stream", "stream_options", "max_completion_tokens"];

export const Lane = Object.freeze({
  OPENCODE_ZEN: "opencode_zen",
  KILO_FREE: "kilo_free",
  CLINE: "cline",
  GROQ_FREE: "groq_free",
  NVIDIA_FREE: "nvidia_free",
  OPENROUTER_FREE: "openrouter_free",
});
