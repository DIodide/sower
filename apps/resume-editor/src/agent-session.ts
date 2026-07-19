import { query } from '@anthropic-ai/claude-agent-sdk';
import { consumeAgentStream, type TranscriptStep } from './transcript.js';

/**
 * The Claude Agent SDK session for 'agent' resume runs.
 *
 * TRUSTED-REPO POSTURE — deliberately different from @sower/investigate's
 * hardened agent runner. The investigator reads ARBITRARY web pages, so it
 * gets no shell/file tools and a starved environment (every page is a
 * potential prompt-injection vector). This agent instead operates on the
 * user's OWN portfolio repo, executing the user's OWN natural-language
 * request:
 *
 *  - File tools + Bash ARE allowed: the work is editing LaTeX, running
 *    `tectonic` to verify the compile, and `git commit`/`git push` — all of
 *    which need the shell. The repo content is the user's, and the prompt is
 *    the user's, so the injection surface the investigator defends against
 *    does not exist here.
 *  - WebSearch/WebFetch (and subagents/notebooks) are removed: nothing in
 *    this task needs the web, and removing it closes the one door through
 *    which third-party text could enter the session.
 *  - The env is still a minimal allowlist: the Claude token, PATH, the
 *    CLAUDE_CONFIG_DIR, and HOME pointed at the run's isolated git-home so
 *    the commit identity + tokenized insteadOf rewrite apply and the agent's
 *    plain `git push` authenticates. DATABASE_URL / vault / GCP secrets from
 *    the parent process never reach the subprocess. NOTE: the GitHub token
 *    is never in the agent's env or argv, but it IS readable via
 *    `git config --get` from that HOME's .gitconfig. Accepted deliberately:
 *    the agent is acting on the user's own credentials, at the user's own
 *    direction, inside the user's own repo — the token grants nothing the
 *    prompt author does not already hold.
 */

const AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

/** Removed outright (defense in depth on top of the restricted base set). */
const DENIED_TOOLS = [
  'WebSearch',
  'WebFetch',
  'Task',
  'Agent',
  'NotebookEdit',
  'Skill',
];

const DEFAULT_MAX_TURNS = 80;

/** Env keys forwarded verbatim; HOME is overridden to the run's git-home. */
const SUBPROCESS_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'PATH',
  'CLAUDE_CONFIG_DIR',
];

export function buildSubprocessEnv(gitHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SUBPROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = gitHome;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export function buildSystemPrompt(texPath: string): string {
  return [
    `You are editing ${texPath} in the user's portfolio repo per their request.`,
    "Follow the repo's conventions (read README/CLAUDE.md if present). You may change other files in the repo when the request requires it.",
    "After LaTeX changes run `tectonic <file>` (from the file's directory) to verify it compiles; fix any errors before finishing.",
    'When you are done, commit with a descriptive message and push — both in the developer/resumes submodule and in the parent repo (bump the submodule pointer) when the submodule changed.',
  ].join('\n');
}

export interface AgentSessionInput {
  /** Absolute path of the portfolio checkout (the session's cwd). */
  cwd: string;
  /** The run's isolated HOME (git identity + tokenized insteadOf config). */
  gitHome: string;
  /** Repo-relative path of the resume being edited. */
  texPath: string;
  /** The user's natural-language request. */
  prompt: string;
  maxTurns?: number;
}

export interface AgentSessionOutcome {
  transcript: TranscriptStep[];
  /** The final result-message text, when the run produced one. */
  resultText?: string;
}

export async function runResumeAgent(
  input: AgentSessionInput,
): Promise<AgentSessionOutcome> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN is not set: agent resume runs require the Claude Code OAuth token in the environment',
    );
  }
  const stream = query({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      systemPrompt: buildSystemPrompt(input.texPath),
      // Base tool set: file tools + Bash (trusted repo — see module comment).
      tools: [...AGENT_TOOLS],
      disallowedTools: [...DENIED_TOOLS],
      // Pre-approve the working set (plus ToolSearch, the harness meta-tool
      // that loads deferred tools) so the headless run never needs a prompt.
      allowedTools: [...AGENT_TOOLS, 'ToolSearch'],
      // Headless: never prompt; auto-deny anything not pre-approved.
      permissionMode: 'dontAsk',
      maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
      env: buildSubprocessEnv(input.gitHome),
    },
  });
  const transcript: TranscriptStep[] = [];
  const capture = await consumeAgentStream(stream, transcript);
  return { transcript, resultText: capture.resultText };
}
