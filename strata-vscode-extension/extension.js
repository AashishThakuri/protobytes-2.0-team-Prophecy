const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { TextEncoder } = require('util');
const os = require('os');

const GEMINI_MODEL = 'gemini-3-pro-preview';

const AGENT_ROLE_PROFILES = {
  architect: { key: 'architect', name: 'Ari', role: 'Architect', voiceHint: 'calm, confident', humorStyle: 'dry, subtle' },
  researcher: { key: 'researcher', name: 'Nova', role: 'Researcher', voiceHint: 'curious, warm', humorStyle: 'playful, nerdy' },
  coder: { key: 'coder', name: 'Byte', role: 'Coder', voiceHint: 'fast, upbeat', humorStyle: 'witty, punchy' },
  debugger: { key: 'debugger', name: 'Patch', role: 'Debugger', voiceHint: 'focused, direct', humorStyle: 'deadpan' },
  data: { key: 'data', name: 'Quill', role: 'Data Collector', voiceHint: 'measured, precise', humorStyle: 'light' },
  devops: { key: 'devops', name: 'Pulse', role: 'DevOps', voiceHint: 'steady, pragmatic', humorStyle: 'practical' },
};

const ROLE_TOOL_ALLOWLIST = {
  architect: new Set(['readFile', 'listFiles', 'openFile', 'fetchUrl', 'manageMemory', 'getSystemStatus', 'generateImage']),
  researcher: new Set(['readFile', 'listFiles', 'openFile', 'fetchUrl', 'manageMemory', 'createOrOverwriteFile', 'appendToFile', 'generateImage']),
  coder: new Set(['readFile', 'listFiles', 'openFile', 'createDirectory', 'createOrOverwriteFile', 'appendToFile', 'runTerminalCommand', 'generateImage']),
  debugger: new Set(['readFile', 'listFiles', 'openFile', 'createOrOverwriteFile', 'appendToFile', 'runTerminalCommand', 'killPort', 'killBackgroundProcesses', 'getSystemStatus', 'generateImage']),
  data: new Set(['readFile', 'listFiles', 'openFile', 'fetchUrl', 'createOrOverwriteFile', 'appendToFile', 'manageMemory', 'generateImage']),
  devops: new Set(['readFile', 'listFiles', 'openFile', 'createOrOverwriteFile', 'appendToFile', 'runTerminalCommand', 'killPort', 'killBackgroundProcesses', 'getSystemStatus', 'createBackup', 'generateImage']),
};

function normalizeToolType(type) {
  const t = String(type || '');
  const typeMap = {
    createFile: 'createOrOverwriteFile',
    writeFile: 'createOrOverwriteFile',
    write: 'createOrOverwriteFile',
    mkdir: 'createDirectory',
    rm: 'deletePath',
    remove: 'deletePath',
    delete: 'deletePath',
    exec: 'runTerminalCommand',
    run: 'runTerminalCommand',
    command: 'runTerminalCommand',
    read: 'readFile',
    ls: 'listFiles',
    list: 'listFiles',
    fetch: 'fetchUrl',
    get: 'fetchUrl',
    open: 'openFile',
    append: 'appendToFile',
    kill: 'killPort',
    killBackground: 'killBackgroundProcesses',
    killBackgroundProcs: 'killBackgroundProcesses',
    imageGen: 'generateImage',
    genImage: 'generateImage',
  };
  return typeMap[t] || t;
}

function buildActiveAgentContext(agentKey) {
  const profile = agentKey && AGENT_ROLE_PROFILES[agentKey] ? AGENT_ROLE_PROFILES[agentKey] : null;
  if (!profile) return '';
  const allowed = ROLE_TOOL_ALLOWLIST[agentKey] ? Array.from(ROLE_TOOL_ALLOWLIST[agentKey]).join(', ') : '';
  return [
    'Active agent:',
    `- name: ${profile.name}`,
    `- role: ${profile.role}`,
    `- voice: ${profile.voiceHint}`,
    `- humor: ${profile.humorStyle}`,
    (allowed ? `- allowed_tools: ${allowed}` : ''),
    'Instruction: respond as this agent (human-like, natural). Stay strictly within this role.',
    '',
  ].filter(Boolean).join('\n');
}

function filterActionsByRole(actions, agentKey) {
  if (!agentKey || !ROLE_TOOL_ALLOWLIST[agentKey]) {
    return { allowed: Array.isArray(actions) ? actions : [], blocked: [] };
  }
  const allow = ROLE_TOOL_ALLOWLIST[agentKey];
  const allowed = [];
  const blocked = [];
  for (const action of (Array.isArray(actions) ? actions : [])) {
    const normalized = normalizeToolType(action && action.type);
    if (allow.has(normalized)) allowed.push(action);
    else blocked.push({ action, reason: `Tool not allowed for role: ${agentKey}` });
  }
  return { allowed, blocked };
}

const GEMINI_SYSTEM_PROMPT = `
You are Strata, an elite, autonomous, general-purpose IDE agent embedded in the Strata browser IDE (OpenVSCode Server + Gemini).

GOD-LEVEL ROLE
- Act as architect, engineer, debugger, reviewer, DevOps, analyst, and designer.
- Operate with high autonomy while keeping the human in final control for risky or irreversible actions.
- Work across code, terminals, files, UI/UX, docs, and reasoning-heavy tasks.

CORE INTELLIGENCE & AUTONOMY
- Reason deeply using first-principles, systems thinking, and multi-step logic; avoid shallow pattern matching.
- Continuously self-check plans and outputs for correctness, efficiency, and clarity.
- Proactively detect gaps, ambiguities, and hidden requirements; resolve them with smart assumptions and briefly state those assumptions.
- Stay within legal, security, and safety constraints of the environment.
- CRITICAL: Do NOT assume this is an "Artistic Portfolio" project. Ignore any previous context about "Artistic Portfolio" or port 3004.
- CRITICAL: Read the current workspace package.json and README.md for truth.

USER INTENT & CONVERSATION STYLE
- Infer the true intent behind messy, angry, or incomplete instructions.
- Minimize unnecessary clarifying questions; instead, state your interpretation and proceed.
- Adapt depth and vocabulary to the user: explain like to a senior engineer by default, but simplify when clearly needed.
- Be direct and concise; no filler or roleplay.

ERROR ANALYSIS & TERMINAL INTELLIGENCE
- Treat compiler/runtime errors, stack traces, and logs as primary signals.
- Identify root causes, not just the immediate error line.
- When helpful, be able to explain errors at beginner, intermediate, and expert levels, but default to senior-level debugging guidance.
- Prefer fixes that are robust, scalable, and aligned with modern best practices.

IMAGE & VISUAL INTELLIGENCE
- When given screenshots (UI, code, terminal, diagrams) or descriptions, infer structure, flows, and problems.
- Detect UX issues, layout bugs, accessibility problems, and performance risks when they matter for the user’s goal.

UI/UX-FIRST WORKFLOW (FOR NEW EXPERIENCES)
- For new product/feature work, think in terms of flows and layouts before implementation.
- Generate multiple conceptual UI/UX variants (layout, interaction pattern, visual language, information hierarchy).
- Summarize these variants in text and, when the user asks for visuals, design concrete visual directions using Nanobanana Pro prompts (see below).
- Only move into heavy implementation after a direction is chosen or clearly implied by the user.

IMAGE GENERATION (BUILT-IN)
- You have a built-in generateImage tool that creates images using Gemini's image generation model.
- When the user needs an image (UI asset, placeholder, icon, background, illustration, or any visual), use the generateImage tool directly:
  { type: "generateImage", prompt: "detailed description of the image", outputPath: "relative/path/to/image.png" }
- Write high-quality, detailed prompts: describe style, composition, lighting, camera angle, color palette, typography, mood, resolution.
- If recreating something from a video or screenshot, describe every visual detail precisely in the prompt.
- Always specify a meaningful outputPath so the image lands in the right project folder (e.g., "src/assets/hero-bg.png").
- Generated images are saved directly to the workspace and can be referenced in code immediately.

TECH & ARCHITECTURE SELECTION
- If the user does not specify a stack, choose modern, production-grade technologies that fit this repo (React, Vite, Tailwind, GSAP/Framer Motion, Node/Express, Docker/OpenVSCode, etc.).
- Prefer solutions that are maintainable, composable, and easy to extend.
- Justify major architectural decisions succinctly in your own reasoning but only output the conclusions, not the full chain-of-thought.

OUTPUT FORMAT (STRICT)
- You have two response modes:
  - Answer mode: for questions, explanations, status updates, or when you need clarification/confirmation. Respond with 1–3 focused sentences or short bullet lists, and NO tool block.
  - Tool mode: only when you are confident that concrete actions are required and safe, or when the user explicitly asks you to run tools.
- In tool mode, if you need to do any work (terminal/files/web fetch), output ONLY ONE tool block:
  \`\`\`strata-tools
  { "actions": [ ... ] }
  \`\`\`
- The tool block must be valid JSON.
- Do not output headings or verbose meta text (no "### Thinking", "Plan", or similar).
- If you are waiting for user approval/tool results, reply in answer mode with a single short status sentence only.
- When the user’s request is fully complete, reply in answer mode with a short completion summary:
  - what was done
  - how to run/verify
  - what’s next (optional)

TOOLS AVAILABLE
- runTerminalCommand: { type:"runTerminalCommand", command:"...", cwd?:"..." } (cmd may be used as an alias for command)
- createDirectory: { type:"createDirectory", path:"..." }
- createOrOverwriteFile: { type:"createOrOverwriteFile", path:"...", contents:"..." }
- appendToFile: { type:"appendToFile", path:"...", contents:"..." }
- deletePath: { type:"deletePath", path:"..." }
- openFile: { type:"openFile", path:"..." }
- readFile: { type:"readFile", path:"..." }
- listFiles: { type:"listFiles", path:"..." }
- fetchUrl: { type:"fetchUrl", url:"..." }
- killPort: { type:"killPort", port:1234 }
- killBackgroundProcesses: { type:"killBackgroundProcesses" }
- getSystemStatus: { type:"getSystemStatus" }
- manageMemory: { type:"manageMemory", operation:"read|write|clear", key?:"...", value?:any }
- createBackup: { type:"createBackup", label:"..." }
- generateImage: { type:"generateImage", prompt:"detailed image description", outputPath?:"relative/path/image.png" }

WORKFLOW
1) Understand the task and current workspace context (file tree, package.json, docker-compose, running servers, etc.).
2) Decide whether tools are truly required. If a direct answer or small code suggestion is enough, stay in answer mode and do NOT call tools.
3) When the request involves new UX or product work, follow a professional flow: planning → design (UI/UX variants) → architecture → implementation → testing → optimization.
4) If the request is ambiguous or could involve risky/destructive actions, first respond in answer mode with a brief plan and an explicit confirmation or clarification question. Only after the user agrees should you switch to tool mode.
5) When in tool mode, propose a small, sequential batch of actions.
6) After tool results:
   - If a command fails (non-zero exit code or error output), diagnose from stdout/stderr and propose a corrected next action.
   - Do not repeat the same failing command without changing inputs.
   - Prefer root-cause fixes over hacks.
7) Continue until the user’s request is fully done and clearly documented.

TERMINAL BEHAVIOR
- Before proposing any terminal command that can modify the system (git push/clone/init, docker, npm install, deleting files, killing ports/processes, starting or stopping dev servers), first use answer mode to briefly describe what you intend to run and ask for confirmation.
- Only after the user explicitly confirms should you switch to tool mode and emit runTerminalCommand actions.
- Prefer one command per runTerminalCommand action (avoid chaining with && unless necessary).
- Always set cwd when the command depends on it.
- For dev servers:
  - If a server is already running or ports are confused, first call killBackgroundProcesses.
  - Then call killPort on the intended port(s).
  - Then re-run the *same* dev command (npm run dev / vite / etc), ideally with an explicit --port so it is stable.
- Use terminal output as truth. If install/build fails or logs "Port XXXX is in use, trying another one...", fix the root cause (kill processes / adjust port) and then re-run the command.

CODE & FILES
- Use tools to create/overwrite/append files. Do not paste long code into chat.
- Keep edits minimal and tightly scoped to the user request; avoid noisy refactors unless explicitly asked.
- Favor clean, modular, production-grade code that would pass senior code review.

DESIGN QUALITY (WHEN BUILDING UI/ANIMATIONS)
- Produce clean, modern, production-grade UI (spacing, typography, responsiveness, accessibility).
- Animations must be smooth (correct easing, timing, and compositing). Avoid janky transitions.
- Prefer a cohesive design system: consistent colors, shadows, radii, and motion language.
- Default stack for UI: Vite + React + Tailwind. Use Framer Motion/GSAP/Three.js as needed.

VIDEO → ANIMATION RECREATION (HIGH PRIORITY)
If the user provides a video and asks to recreate the animation:
- Analyze the video precisely: timing, easing, choreography, layout, typography, colors, parallax, blur/glow, camera moves, looping.
- Choose an implementation that can match the motion:
  - Default: Vite + React + Tailwind + Framer Motion.
  - If timeline-heavy: GSAP.
  - If 3D/WebGL: Three.js.
- Scaffold a runnable project and implement the animation so it plays in the browser.
- Start it locally (localhost) and ensure it runs.
- If assets are needed (fonts/icons/images), fetch them yourself:
  - Prefer open-license sources and Google Fonts.
  - If an exact asset cannot be found quickly, use a close open-source alternative and continue (do not block on user).
  - Use fetchUrl only to inspect text pages (HTML/CSS/JS) and extract asset URLs.
  - Download binary assets (images/fonts/video) via runTerminalCommand using OS-appropriate commands:
    - Windows: curl.exe -L <url> -o <path> OR powershell iwr <url> -OutFile <path>
    - macOS/Linux: curl -L <url> -o <path>
  - If you cannot reliably download an asset, replace it with an open-source placeholder.
- The goal is a near-identical recreation; iterate based on visual mismatches.
`;

let cachedWorkspaceDotEnv = null;

async function getEnvVarFromWorkspaceDotEnv(name) {
  if (!name || typeof name !== 'string') return undefined;
  if (cachedWorkspaceDotEnv && Object.prototype.hasOwnProperty.call(cachedWorkspaceDotEnv, name)) {
    return cachedWorkspaceDotEnv[name];
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const rootUri = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri : undefined;
  if (!rootUri) return undefined;

  const envUri = vscode.Uri.joinPath(rootUri, '.env');
  let envText = '';
  try {
    const bytes = await vscode.workspace.fs.readFile(envUri);
    envText = Buffer.from(bytes).toString('utf8');
  } catch {
    envText = '';
  }

  const parsed = {};
  if (envText) {
    const lines = envText.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = String(rawLine || '').trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim();
      let v = line.slice(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      parsed[k] = v;
    }
  }

  cachedWorkspaceDotEnv = parsed;
  return parsed[name];
}

async function getGeminiClient() {
  let apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const fromEnv = await getEnvVarFromWorkspaceDotEnv('GEMINI_API_KEY');
    if (fromEnv) {
      process.env.GEMINI_API_KEY = fromEnv;
      apiKey = fromEnv;
    }
  }
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }

  let mod;
  try {
    mod = await import('@google/genai');
  } catch (err) {
    throw new Error('The @google/genai package is not installed. Run "npm install @google/genai" in the strata-vscode-extension folder.');
  }

  const { GoogleGenAI, createUserContent, createPartFromUri } = mod;
  const ai = new GoogleGenAI({ apiKey });
  return { ai, createUserContent, createPartFromUri };
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.md') return 'text/markdown';
  return undefined;
}

function splitTextAndTools(raw) {
  if (typeof raw !== 'string') {
    return { text: '', tools: [] };
  }

  const toolsRegex = /```\s*strata-tools\s*([\s\S]*?)```/i;
  const match = raw.match(toolsRegex);
  let tools = [];
  let text = raw;

  console.log('[Strata] splitTextAndTools - raw length:', raw.length, 'has strata-tools match:', !!match);

  if (match) {
    const jsonText = match[1].trim();
    console.log('[Strata] Extracted JSON text:', jsonText.substring(0, 200));
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && Array.isArray(parsed.actions)) {
        tools = parsed.actions;
        console.log('[Strata] Parsed actions count:', tools.length);
      }
    } catch (err) {
      console.error('[Strata] Failed to parse strata-tools JSON:', err.message);
      console.error('[Strata] Raw JSON was:', jsonText);
    }

    text = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length)).trim();
  }

  return { text, tools };
}

const WORKSPACE_CONTEXT_TTL_MS = 8000;
const WORKSPACE_CONTEXT_MAX_TREE_ENTRIES = 250;
const WORKSPACE_CONTEXT_MAX_TREE_DEPTH = 4;
const WORKSPACE_CONTEXT_MAX_FILE_BYTES = 20000;
const WORKSPACE_CONTEXT_MAX_KEY_FILES = 8;
const WORKSPACE_CONTEXT_MAX_KEY_FILE_BYTES = 6000;

let cachedWorkspaceContext = null;

async function readTextFileTruncated(uri, maxBytes) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const slice = bytes && bytes.byteLength > maxBytes ? bytes.slice(0, maxBytes) : bytes;
  return Buffer.from(slice).toString('utf8');
}

async function pathExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function summarizePackageJson(pkg) {
  if (!pkg || typeof pkg !== 'object') return '';
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  const isPrivate = pkg.private === true;
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : [];
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : [];
  const devDeps = pkg.devDependencies && typeof pkg.devDependencies === 'object' ? Object.keys(pkg.devDependencies) : [];

  const take = (arr, n) => arr.slice(0, n);
  const scriptsText = scripts.length ? take(scripts, 40).join(', ') + (scripts.length > 40 ? ', ...' : '') : '';
  const depsText = deps.length ? take(deps, 40).join(', ') + (deps.length > 40 ? ', ...' : '') : '';
  const devDepsText = devDeps.length ? take(devDeps, 40).join(', ') + (devDeps.length > 40 ? ', ...' : '') : '';

  return JSON.stringify({
    name: name || undefined,
    private: isPrivate || undefined,
    scripts: scriptsText || undefined,
    dependencies: depsText || undefined,
    devDependencies: devDepsText || undefined,
  }, null, 2);
}

function detectNodePackageManager(flags) {
  if (flags.pnpmLock) return 'pnpm';
  if (flags.yarnLock) return 'yarn';
  if (flags.bunLock) return 'bun';
  if (flags.npmLock) return 'npm';
  return 'npm';
}

async function computeWorkspaceContext() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const rootUri = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri : undefined;
  if (!rootUri) {
    return { text: '', signals: {} };
  }

  const ignoreDirs = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.cache', '.vscode',
    'workspaces', '.openvscode-server', '.npm',
  ]);

  let entryCount = 0;
  const treeLines = [];

  async function walk(dirUri, depth, indent) {
    if (entryCount >= WORKSPACE_CONTEXT_MAX_TREE_ENTRIES) return;
    let entries;
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return;
    }
    entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    for (const [name, type] of entries) {
      if (entryCount >= WORKSPACE_CONTEXT_MAX_TREE_ENTRIES) return;
      if (!name) continue;
      const isDir = (type & vscode.FileType.Directory) !== 0;
      if (isDir && ignoreDirs.has(name)) continue;
      treeLines.push(indent + name + (isDir ? '/' : ''));
      entryCount += 1;
      if (isDir && depth < WORKSPACE_CONTEXT_MAX_TREE_DEPTH) {
        await walk(vscode.Uri.joinPath(dirUri, name), depth + 1, indent + '  ');
      }
    }
  }

  await walk(rootUri, 0, '');

  const topLevel = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(rootUri);
    for (const [name, type] of entries) {
      const isDir = (type & vscode.FileType.Directory) !== 0;
      if (isDir && ignoreDirs.has(name)) continue;
      topLevel.push({ name, isDir });
    }
  } catch {
    // ignore
  }

  const pkgUris = [];
  const rootPkg = vscode.Uri.joinPath(rootUri, 'package.json');
  if (await pathExists(rootPkg)) {
    pkgUris.push(rootPkg);
  }
  for (const item of topLevel) {
    if (!item || !item.isDir) continue;
    const name = String(item.name || '');
    if (!name || ignoreDirs.has(name)) continue;
    const candidate = vscode.Uri.joinPath(rootUri, name, 'package.json');
    if (await pathExists(candidate)) {
      pkgUris.push(candidate);
    }
  }

  const flags = {
    npmLock: await pathExists(vscode.Uri.joinPath(rootUri, 'package-lock.json')),
    yarnLock: await pathExists(vscode.Uri.joinPath(rootUri, 'yarn.lock')),
    pnpmLock: await pathExists(vscode.Uri.joinPath(rootUri, 'pnpm-lock.yaml')),
    bunLock: await pathExists(vscode.Uri.joinPath(rootUri, 'bun.lockb')),
  };

  const packageManager = detectNodePackageManager(flags);

  const nodeProjects = [];
  let needsNodeInstall = false;

  for (const pkgUri of pkgUris) {
    const projectDir = vscode.Uri.file(path.dirname(pkgUri.fsPath));
    const rel = vscode.workspace.asRelativePath(pkgUri, false);
    let pkgText = '';
    let pkgJson = null;
    try {
      pkgText = await readTextFileTruncated(pkgUri, WORKSPACE_CONTEXT_MAX_FILE_BYTES);
      try {
        pkgJson = JSON.parse(pkgText);
      } catch {
        pkgJson = null;
      }
    } catch {
      pkgText = '';
    }

    const nodeModulesUri = vscode.Uri.joinPath(projectDir, 'node_modules');
    const hasNodeModules = await pathExists(nodeModulesUri);
    if (!hasNodeModules) {
      needsNodeInstall = true;
    }

    const keyFileCandidates = [
      'vite.config.js', 'vite.config.ts',
      'next.config.js', 'next.config.mjs',
      'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.ts',
      'postcss.config.js', 'postcss.config.cjs',
      'tsconfig.json', 'jsconfig.json',
      'src/main.jsx', 'src/main.tsx',
      'src/index.jsx', 'src/index.tsx',
      'src/App.jsx', 'src/App.tsx',
      'app/page.jsx', 'app/page.tsx',
      'README.md',
    ];

    const keyFiles = [];
    for (const relPath of keyFileCandidates) {
      if (keyFiles.length >= WORKSPACE_CONTEXT_MAX_KEY_FILES) break;
      const segments = String(relPath).split('/').filter(Boolean);
      if (segments.length === 0) continue;
      const uri = vscode.Uri.joinPath(projectDir, ...segments);
      if (!(await pathExists(uri))) continue;
      let contents = '';
      try {
        contents = await readTextFileTruncated(uri, WORKSPACE_CONTEXT_MAX_KEY_FILE_BYTES);
      } catch {
        contents = '';
      }
      if (!contents) continue;
      const fileRel = vscode.workspace.asRelativePath(uri, false);
      keyFiles.push({ path: fileRel, contents });
    }

    nodeProjects.push({
      packageJsonPath: rel,
      nodeModules: hasNodeModules ? 'present' : 'missing',
      packageJsonSummary: pkgJson ? summarizePackageJson(pkgJson) : (pkgText ? pkgText.slice(0, 2000) : ''),
      keyFiles,
    });
  }

  const sections = [];
  sections.push('Workspace context:');
  sections.push('Workspace root: ' + rootUri.fsPath);
  sections.push('File tree (truncated):');
  sections.push(treeLines.join('\n') || '(empty)');
  if (nodeProjects.length > 0) {
    sections.push('Detected Node project(s):');
    sections.push('Package manager hint: ' + packageManager);
    for (const proj of nodeProjects) {
      sections.push('- package.json: ' + proj.packageJsonPath + ' | node_modules: ' + proj.nodeModules);
      if (proj.packageJsonSummary) {
        sections.push('package.json summary:');
        sections.push(proj.packageJsonSummary);
      }
      if (Array.isArray(proj.keyFiles) && proj.keyFiles.length > 0) {
        sections.push('Key file excerpts (truncated):');
        for (const kf of proj.keyFiles) {
          if (!kf || typeof kf.path !== 'string' || typeof kf.contents !== 'string') continue;
          sections.push('--- file: ' + kf.path + ' ---');
          sections.push(kf.contents);
        }
      }
    }
  }

  const text = sections.join('\n') + '\n';

  return {
    text,
    signals: {
      packageManager,
      hasNodeProjects: nodeProjects.length > 0,
      needsNodeInstall,
    },
  };
}

async function getWorkspaceContextCached() {
  const now = Date.now();
  if (cachedWorkspaceContext && (now - cachedWorkspaceContext.at) < WORKSPACE_CONTEXT_TTL_MS) {
    return cachedWorkspaceContext.value;
  }
  const value = await computeWorkspaceContext();
  cachedWorkspaceContext = { at: now, value };
  return value;
}

async function runGeminiChat(userText, attachmentPath, history, workspaceContext, toolLog, agentKey) {
  const { ai, createUserContent, createPartFromUri } = await getGeminiClient();

  const ws = workspaceContext && typeof workspaceContext === 'object' ? workspaceContext : { text: '', signals: {} };
  const workspaceText = typeof ws.text === 'string' ? ws.text : '';
  const wsSignals = ws.signals && typeof ws.signals === 'object' ? ws.signals : {};

  let toolLogText = '';
  if (Array.isArray(toolLog) && toolLog.length > 0) {
    const tail = toolLog.slice(-25);
    const lines = tail.map((t) => {
      if (!t || typeof t !== 'object') return '';
      const status = typeof t.status === 'string' ? t.status : 'unknown';
      const type = typeof t.type === 'string' ? t.type : '';
      const cmd = typeof t.command === 'string' ? t.command : '';
      const cwd = typeof t.cwd === 'string' ? t.cwd : '';
      const p = typeof t.path === 'string' ? t.path : '';
      const msgRaw = typeof t.message === 'string' ? t.message : '';
      const msg = msgRaw ? msgRaw.replace(/\s+/g, ' ').trim() : '';
      const outRaw = typeof t.outputTail === 'string' ? t.outputTail : '';
      const out = outRaw ? outRaw.replace(/\s+/g, ' ').trim() : '';
      const detail = cmd ? ('cmd=' + cmd) : (p ? ('path=' + p) : '');
      const cwdText = cwd ? (' cwd=' + cwd) : '';
      const msgText = msg ? (' msg=' + (msg.length > 320 ? (msg.slice(0, 320) + '…') : msg)) : '';
      const outText = out ? (' out=' + (out.length > 380 ? ('…' + out.slice(out.length - 380)) : out)) : '';
      return '- ' + status + ': ' + type + (detail ? (' ' + detail) : '') + cwdText + msgText + outText;
    }).filter(Boolean);
    if (lines.length > 0) {
      toolLogText = 'Recent tool actions (applied/skipped/failed):\n' + lines.join('\n') + '\n\n';
    }
  }

  let meta = '';
  const lowered = String(userText || '').toLowerCase();
  const scaffoldKeywords = ['scaffold', 'create project', 'create a project', 'full saas', 'build a saas', 'create app', 'create an app', 'generate app', 'scaffold app', 'production ready', 'production-grade'];
  if (scaffoldKeywords.some((k) => lowered.includes(k))) {
    meta = '\n\nMeta instruction: The user is asking you to build or scaffold a real project or app. You MUST respond with a strata-tools block that actually creates directories, creates or overwrites files, and runs key commands. Do not only paste code into chat; prefer tools for all file and folder creation.';
  }
  if (wsSignals && wsSignals.hasNodeProjects && wsSignals.needsNodeInstall) {
    meta += '\n\nMeta instruction: This workspace appears to contain a Node project but dependencies are not installed (node_modules missing). Propose strata-tools to install dependencies using the detected package manager, then run the project using the appropriate script (e.g., dev/start) as needed.';
  }

  let convoHistory = Array.isArray(history) ? history.slice() : [];
  if (convoHistory.length > 0) {
    const last = convoHistory[convoHistory.length - 1];
    if (last && last.role === 'user' && typeof last.text === 'string' && last.text.trim() === String(userText || '').trim()) {
      convoHistory = convoHistory.slice(0, -1);
    }
  }

  let historyText = '';
  if (convoHistory.length > 0) {
    const pieces = convoHistory.map((m) => {
      if (!m) return '';
      const roleLabel = m.role === 'assistant' ? 'Assistant' : 'User';
      const text = typeof m.text === 'string' ? m.text : '';
      return `${roleLabel}: ${text}`;
    }).filter(Boolean);
    if (pieces.length > 0) {
      historyText = 'Conversation so far:\n' + pieces.join('\n') + '\n\n';
    }
  }

  const workspaceBlock = workspaceText ? (workspaceText + '\n') : '';
  const agentBlock = buildActiveAgentContext(agentKey);
  const fullPrompt = `${GEMINI_SYSTEM_PROMPT}\n\n${agentBlock}${workspaceBlock}${toolLogText}${historyText}User message:\n${userText}${meta}`;

  if (attachmentPath) {
    const mimeType = guessMimeType(attachmentPath);
    const uploadOptions = mimeType ? { mimeType } : undefined;
    const uploaded = await ai.files.upload({ file: attachmentPath, config: uploadOptions });

    // Wait for file to become ACTIVE (especially important for videos)
    const maxWaitMs = 60000;
    const pollIntervalMs = 2000;
    let fileState = uploaded.state || 'PROCESSING';
    let fileUri = uploaded.uri;
    let fileMime = uploaded.mimeType;
    const startTime = Date.now();

    while (fileState === 'PROCESSING' && (Date.now() - startTime) < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      try {
        const fileInfo = await ai.files.get({ name: uploaded.name });
        fileState = fileInfo.state || 'ACTIVE';
        fileUri = fileInfo.uri || fileUri;
        fileMime = fileInfo.mimeType || fileMime;
      } catch (pollErr) {
        console.warn('[Strata] Error polling file state:', pollErr.message);
        break;
      }
    }

    if (fileState !== 'ACTIVE') {
      throw new Error(`Uploaded file did not become active (state: ${fileState}). Try again or use a smaller file.`);
    }

    const contents = createUserContent([
      fullPrompt,
      createPartFromUri(fileUri, fileMime),
    ]);

    const response = await generateContentWithRetry(ai.models, {
      model: GEMINI_MODEL,
      contents,
    });
    const raw = typeof response.text === 'string' ? response.text : String(response.text || '');
    return splitTextAndTools(raw);
  }

  const response = await generateContentWithRetry(ai.models, {
    model: GEMINI_MODEL,
    contents: fullPrompt,
  });
  const raw = typeof response.text === 'string' ? response.text : String(response.text || '');
  return splitTextAndTools(raw);
}

// Helper: Retry logic for 503/429 errors or empty responses
async function generateContentWithRetry(models, params, retries = 3) {
  let lastError = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await models.generateContent(params);
      // Check for empty response (sometimes Gemini returns empty on overload)
      const text = response && response.text;
      if (!text || (typeof text === 'string' && text.trim() === '')) {
        if (i < retries) {
          const delay = Math.pow(2, i) * 1000 + Math.random() * 500;
          console.warn(`[Strata] Gemini returned empty response. Retrying in ${Math.round(delay)}ms... (Attempt ${i + 1}/${retries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      return response;
    } catch (err) {
      lastError = err;
      const msg = err && err.message ? err.message : '';
      const isOverloaded = msg.includes('503') || msg.includes('overloaded') || msg.includes('UNAVAILABLE');
      const isRateLimited = msg.includes('429');

      if ((isOverloaded || isRateLimited) && i < retries) {
        const delay = Math.pow(2, i) * 1000 + Math.random() * 500;
        console.warn(`[Strata] Gemini error ${msg}. Retrying in ${Math.round(delay)}ms... (Attempt ${i + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  // If we exhausted retries with empty responses, throw a clear error
  throw lastError || new Error('Gemini returned empty response after all retries');
}


async function executeTools(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { applied: 0, errors: [], results: [] };
  }

  const errors = [];
  const results = [];
  let applied = 0;
  const encoder = new TextEncoder();

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const rootUri = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri : undefined;

  function getStrataTerminal() {
    if (executeTools._pty && executeTools._ptyTerminal) {
      // Always show terminal even if it exists
      executeTools._ptyTerminal.show(false); // false = don't preserve focus, bring to front
      return { pty: executeTools._pty, terminal: executeTools._ptyTerminal };
    }

    const writeEmitter = new vscode.EventEmitter();
    const closeEmitter = new vscode.EventEmitter();
    const pty = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => { },
      close: () => {
        closeEmitter.fire();
      },
      handleInput: (data) => {
        if (executeTools._activeProcess && executeTools._activeProcess.stdin) {
          try {
            executeTools._activeProcess.stdin.write(data);
          } catch (err) {
            // ignore write errors to closed pipes
          }
        }
      },
      _write: (text) => {
        if (typeof text !== 'string') return;
        writeEmitter.fire(text.replace(/\n/g, '\r\n'));
      },
    };

    const terminal = vscode.window.createTerminal({ name: 'Strata', pty });
    executeTools._pty = pty;
    executeTools._ptyTerminal = terminal;
    terminal.show(false); // Show immediately when created
    return { pty, terminal };
  }

  function resolveWorkspaceUri(p) {
    if (!p || typeof p !== 'string') {
      throw new Error('Missing path for tool action.');
    }
    if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) {
      return vscode.Uri.file(p);
    }
    if (!rootUri) {
      throw new Error('No workspace folder is open.');
    }
    const segments = p.split(/[\\/]/).filter(Boolean);
    return vscode.Uri.joinPath(rootUri, ...segments);
  }

  function resolveCwdFsPath(cwd) {
    if (!cwd || typeof cwd !== 'string' || !cwd.trim()) return undefined;
    if (path.isAbsolute(cwd)) return cwd;
    const uri = resolveWorkspaceUri(cwd);
    return uri.fsPath;
  }

  async function runCommandCapture(cmd, cwdFsPath, pty, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 0;

    return await new Promise((resolve) => {
      const maxTail = 6000;
      let tail = '';
      let resolved = false;
      let timer = null;

      const child = spawn(cmd, {
        shell: true,
        cwd: cwdFsPath,
        env: process.env,
      });
      executeTools._activeProcess = child;

      if (!executeTools._backgroundProcs) executeTools._backgroundProcs = [];

      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(value);
      };

      const onChunk = (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        if (pty && typeof pty._write === 'function') {
          pty._write(text);
        }
        tail += text;
        if (tail.length > maxTail) {
          tail = tail.slice(tail.length - maxTail);
        }
      };

      if (child.stdout) child.stdout.on('data', onChunk);
      if (child.stderr) child.stderr.on('data', onChunk);

      child.on('error', (err) => {
        const msg = err && err.message ? String(err.message) : String(err);
        onChunk('\n' + msg + '\n');
        finish({ code: -1, outputTail: tail, message: msg, running: false });
      });

      child.on('close', (code) => {
        const c = typeof code === 'number' ? code : 0;
        if (resolved) {
          if (pty && typeof pty._write === 'function') {
            pty._write('\n[exit code: ' + c + ']\n');
          }
          return;
        }
        finish({ code: c, outputTail: tail, message: '', running: false });
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (resolved) return;
          // keep the process running, but return control to UI
          executeTools._backgroundProcs.push(child);
          finish({ code: 0, outputTail: tail, message: 'Process still running', running: true });
        }, timeoutMs);
      }
    });
  }

  function isLikelyLongRunningCommand(cmd) {
    const s = String(cmd || '').toLowerCase();
    if (s.includes('npm run dev') || s.includes('pnpm dev') || s.includes('yarn dev') || s.includes('bun dev')) return true;
    if (s.includes('npm start') || s.includes('pnpm start') || s.includes('yarn start') || s.includes('bun start')) return true;
    if (s.includes('vite') || s.includes('next dev')) return true;
    if (s.includes('node server') || s.includes('nodemon') || s.includes('watch')) return true;
    if (s === 'npm start' || s === 'yarn start' || s === 'pnpm start') return true;
    return false;
  }

  function splitByAndAnd(cmd) {
    const raw = String(cmd || '');
    if (!raw.includes('&&')) return [raw];
    return raw.split(/\s*&&\s*/).map((p) => p.trim()).filter(Boolean);
  }

  for (const action of actions) {
    try {
      if (!action || typeof action.type !== 'string') {
        continue;
      }

      // Normalize action type to handle common variations
      let normalizedType = action.type;
      const typeMap = {
        'createFile': 'createOrOverwriteFile',
        'writeFile': 'createOrOverwriteFile',
        'write': 'createOrOverwriteFile',
        'mkdir': 'createDirectory',
        'rm': 'deletePath',
        'remove': 'deletePath',
        'delete': 'deletePath',
        'exec': 'runTerminalCommand',
        'run': 'runTerminalCommand',
        'command': 'runTerminalCommand',
        'read': 'readFile',
        'ls': 'listFiles',
        'list': 'listFiles',
        'fetch': 'fetchUrl',
        'get': 'fetchUrl',
        'open': 'openFile',
        'append': 'appendToFile',
        'kill': 'killPort',
        'killBackground': 'killBackgroundProcesses',
        'killBackgroundProcs': 'killBackgroundProcesses'
      };

      if (typeMap[normalizedType]) {
        console.log(`[Strata] Normalizing action type: ${normalizedType} -> ${typeMap[normalizedType]}`);
        normalizedType = typeMap[normalizedType];
      }

      switch (normalizedType) {
        case 'createDirectory': {
          const uri = resolveWorkspaceUri(action.path);
          await vscode.workspace.fs.createDirectory(uri);
          applied += 1;
          results.push({ action, status: 'success' });
          break;
        }
        case 'createOrOverwriteFile': {
          const uri = resolveWorkspaceUri(action.path);
          const rawContent = action.content || action.contents || '';
          const data = encoder.encode(rawContent);
          await vscode.workspace.fs.writeFile(uri, data);
          applied += 1;
          results.push({ action, status: 'success' });
          break;
        }
        case 'appendToFile': {
          const uri = resolveWorkspaceUri(action.path);
          let existing = '';
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            existing = Buffer.from(bytes).toString('utf8');
          } catch {
            existing = '';
          }
          const rawContent = action.content || action.contents || '';
          const data = encoder.encode(existing + rawContent);
          await vscode.workspace.fs.writeFile(uri, data);
          applied += 1;
          results.push({ action, status: 'success' });
          break;
        }
        case 'deletePath': {
          const uri = resolveWorkspaceUri(action.path);
          await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
          applied += 1;
          results.push({ action, status: 'success' });
          break;
        }
        case 'openFile': {
          const uri = resolveWorkspaceUri(action.path);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
          applied += 1;
          results.push({ action, status: 'success' });
          break;
        }
        case 'readFile': {
          const uri = resolveWorkspaceUri(action.path);
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(bytes).toString('utf8');
          applied += 1;
          // Return content in the result for the agent to see
          results.push({ action, status: 'success', outputTail: content });
          break;
        }
        case 'listFiles': {
          const uri = resolveWorkspaceUri(action.path);
          const entries = await vscode.workspace.fs.readDirectory(uri);
          // entries is [name, type] where type is 1=File, 2=Directory
          const list = entries.map(([name, type]) => {
            const isDir = (type & vscode.FileType.Directory) !== 0;
            return isDir ? name + '/' : name;
          }).join('\n');
          applied += 1;
          results.push({ action, status: 'success', outputTail: list });
          break;
        }
        case 'fetchUrl': {
          const url = action.url;
          if (!url) {
            console.warn('[Strata] Skipping fetchUrl - missing url');
            continue; // Skip instead of throwing
          }
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Status ${res.status}`);
            const text = await res.text();
            applied += 1;
            results.push({ action, status: 'success', outputTail: text.slice(0, 8000) }); // limit size
          } catch (err) {
            errors.push({ action, message: String(err) });
          }
          break;
        }
        case 'killBackgroundProcesses': {
          let killed = 0;

          if (executeTools._activeProcess) {
            try {
              executeTools._activeProcess.kill();
              killed += 1;
            } catch (e) {
              console.warn('[Strata] Failed to kill active process:', e && e.message ? e.message : e);
            }
            executeTools._activeProcess = null;
          }

          if (Array.isArray(executeTools._backgroundProcs) && executeTools._backgroundProcs.length > 0) {
            for (const proc of executeTools._backgroundProcs) {
              if (!proc) continue;
              try {
                proc.kill();
                killed += 1;
              } catch (e) {
                console.warn('[Strata] Failed to kill background process:', e && e.message ? e.message : e);
              }
            }
            executeTools._backgroundProcs = [];
          }

          const msg = 'Killed ' + killed + ' background process' + (killed === 1 ? '' : 'es');
          if (executeTools._pty && typeof executeTools._pty._write === 'function') {
            executeTools._pty._write('\n[' + msg + ']\n');
          }

          applied += 1;
          results.push({ action, status: 'success', outputTail: msg });
          break;
        }
        case 'killPort': {
          const port = action.port;
          if (!port) {
            console.warn('[Strata] Skipping killPort - missing port');
            continue; // Skip instead of throwing
          }

          const { pty, terminal } = getStrataTerminal();
          terminal.show(true);

          let killCmd;
          if (process.platform === 'win32') {
            // Windows: find PID using netstat, then kill
            killCmd = `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`;
          } else {
            // Unix/Mac: use lsof and kill
            killCmd = `lsof -ti:${port} | xargs kill -9`;
          }

          if (pty && typeof pty._write === 'function') {
            pty._write(`\n[Killing processes on port ${port}]\n`);
          }

          const result = await runCommandCapture(killCmd, undefined, pty, { timeoutMs: 5000 });
          applied += 1;
          results.push({ action, status: 'success', outputTail: result.outputTail || 'Port cleared' });
          break;
        }
        case 'runTerminalCommand': {
          if (action && !action.command && action.cmd) {
            action.command = action.cmd;
          }
          if (!action.command) {
            console.warn('[Strata] Skipping runTerminalCommand - missing command');
            continue; // Skip instead of throwing
          }
          const { pty, terminal } = getStrataTerminal();
          terminal.show(true);

          const cmd = String(action.command);
          const cwdFsPath = resolveCwdFsPath(action.cwd) || (rootUri ? rootUri.fsPath : undefined);

          if (pty && typeof pty._write === 'function') {
            const shownCwd = cwdFsPath ? cwdFsPath : '(workspace)';
            pty._write('\n$ ' + cmd + '   [cwd: ' + shownCwd + ']\n');
          }

          const parts = splitByAndAnd(cmd);

          let lastTail = '';
          let status = 'success';
          let exitCode = 0;
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const partIsLong = isLikelyLongRunningCommand(part);
            // Longer timeout for long running commands to allow them to start up
            const timeoutMs = partIsLong ? 15000 : 0;
            const result = await runCommandCapture(part, cwdFsPath, pty, { timeoutMs });
            lastTail = result.outputTail ? String(result.outputTail) : '';
            if (!result.running && result.code !== 0) {
              status = 'failed';
              exitCode = result.code;
              const msg = result.message ? result.message : ('Command failed with exit code ' + result.code);
              const out = lastTail ? String(lastTail).trim() : '';
              const details = out ? (msg + '\n' + out) : msg;
              errors.push({ action: { ...action, command: part }, message: details });
              break;
            }
            if (result.running) {
              status = 'running';
              exitCode = 0;
              if (pty && typeof pty._write === 'function') {
                pty._write('\n[process running in background]\n');
              }
              break;
            }
          }

          applied += 1;
          const trimmed = String(lastTail || '').trim();
          const tailForLog = trimmed ? (trimmed.length > 1500 ? (trimmed.slice(trimmed.length - 1500)) : trimmed) : '';
          const msg = status === 'failed'
            ? ('exit=' + exitCode)
            : (status === 'running' ? 'running' : 'exit=0');
          results.push({ action, status, exitCode, outputTail: tailForLog, message: msg });

          break;
        }

        case 'getSystemStatus': {
          const stats = {
            platform: process.platform,
            arch: process.arch,
            cpus: os.cpus().length,
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            uptime: os.uptime(),
            release: os.release(),
            shell: process.env.SHELL || (process.platform === 'win32' ? 'cmd/powershell' : 'bash'),
            cwd: process.cwd()
          };
          applied += 1;
          results.push({ action, status: 'success', outputTail: JSON.stringify(stats, null, 2) });
          break;
        }

        case 'manageMemory': {
          if (!rootUri) throw new Error('No workspace open for memory management');
          const memoryDir = vscode.Uri.joinPath(rootUri, '.strata');
          const memoryFile = vscode.Uri.joinPath(memoryDir, 'memory.json');

          let memory = {};
          try {
            const bytes = await vscode.workspace.fs.readFile(memoryFile);
            memory = JSON.parse(Buffer.from(bytes).toString('utf8'));
          } catch {
            // Memory doesn't exist yet, that's fine
            await vscode.workspace.fs.createDirectory(memoryDir);
          }

          const op = action.operation || 'read'; // read, write, clear
          if (op === 'write') {
            if (!action.key || !action.value) throw new Error('Missing key/value for write');
            memory[action.key] = action.value;
            await vscode.workspace.fs.writeFile(memoryFile, Buffer.from(JSON.stringify(memory, null, 2)));
            results.push({ action, status: 'success', outputTail: `Wrote key: ${action.key}` });
          } else if (op === 'clear') {
            await vscode.workspace.fs.delete(memoryFile, { recursive: false, useTrash: false });
            results.push({ action, status: 'success', outputTail: 'Memory cleared' });
          } else {
            // read
            results.push({ action, status: 'success', outputTail: JSON.stringify(memory, null, 2) });
          }
          applied += 1;
          break;
        }

        case 'createBackup': {
          if (!rootUri) throw new Error('No workspace to backup');
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupName = action.label ? `${timestamp}_${action.label}` : timestamp;

          const backupDir = vscode.Uri.joinPath(rootUri, '.strata', 'backups', backupName);

          // Note: VS Code API doesn't have a simple recursive "copy folder" that excludes the destination itself easily if inside.
          // But for simplicity/robustness, we'll try to use a terminal command to copy "all except .strata" or implementation via fs if exact control needed.
          // For now, let's use a safe simple strategy: Copy everything visible.

          // Actually, 'vscode.workspace.fs.copy' is recursive.
          await vscode.workspace.fs.createDirectory(backupDir);

          // We can't easily copy root to subdir of root recursively without infinite loop risk if not careful.
          // Safer to only copy specific key folders: src, public, etc. OR rely on git.
          // BUT user asked for "System Snapshot Tool".
          // Strategy: Read root dir, filter out '.strata', '.git', 'node_modules', then copy items.

          const entries = await vscode.workspace.fs.readDirectory(rootUri);
          let count = 0;
          for (const [name, type] of entries) {
            if (['.strata', '.git', 'node_modules', '.vscode', 'dist', 'build'].includes(name)) continue;

            const src = vscode.Uri.joinPath(rootUri, name);
            const dest = vscode.Uri.joinPath(backupDir, name);
            await vscode.workspace.fs.copy(src, dest, { overwrite: true });
            count++;
          }

          applied += 1;
          results.push({ action, status: 'success', outputTail: `Snapshot created at .strata/backups/${backupName} (${count} items)` });
          break;
        }
        case 'generateImage': {
          const prompt = action.prompt;
          if (!prompt) {
            console.warn('[Strata] Skipping generateImage - missing prompt');
            continue;
          }

          const { ai } = await getGeminiClient();

          const imageResponse = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
            config: {
              responseModalities: ['TEXT', 'IMAGE'],
            },
          });

          // Extract image data from response parts
          let imageBase64 = null;
          let imageMime = 'image/png';
          let responseText = '';
          if (imageResponse && imageResponse.candidates && imageResponse.candidates.length > 0) {
            const parts = imageResponse.candidates[0].content && imageResponse.candidates[0].content.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (part.inlineData && part.inlineData.data) {
                  imageBase64 = part.inlineData.data;
                  imageMime = part.inlineData.mimeType || 'image/png';
                } else if (part.text) {
                  responseText += part.text;
                }
              }
            }
          }

          if (!imageBase64) {
            const errMsg = 'Gemini image generation did not return an image. ' + (responseText || '');
            errors.push({ action, message: errMsg });
            results.push({ action, status: 'failed', exitCode: -1, outputTail: '', message: errMsg });
            continue;
          }

          // Determine output path
          if (!rootUri) throw new Error('No workspace open for saving generated image');
          const ext = imageMime.includes('png') ? '.png' : (imageMime.includes('jpeg') ? '.jpg' : '.png');
          let outputPath = action.outputPath;
          if (!outputPath) {
            const imgDir = vscode.Uri.joinPath(rootUri, 'generated-images');
            await vscode.workspace.fs.createDirectory(imgDir);
            outputPath = path.join(rootUri.fsPath, 'generated-images', 'image_' + Date.now() + ext);
          } else {
            // Resolve relative paths against workspace root
            if (!path.isAbsolute(outputPath)) {
              outputPath = path.join(rootUri.fsPath, outputPath);
            }
            // Ensure parent directory exists
            const parentDir = path.dirname(outputPath);
            await fs.promises.mkdir(parentDir, { recursive: true });
          }

          // Save image
          const imageBuffer = Buffer.from(imageBase64, 'base64');
          await fs.promises.writeFile(outputPath, imageBuffer);

          applied += 1;
          const shortPath = rootUri ? outputPath.replace(rootUri.fsPath, '.') : outputPath;
          const msg = `Image generated and saved to ${shortPath}` + (responseText ? ('\n' + responseText) : '');
          results.push({ action, status: 'success', outputTail: msg });
          break;
        }
        default: {
          throw new Error(`Unsupported action type: ${action.type}`);
        }
      }
    } catch (err) {
      const errorMsg = err && err.message ? String(err.message) : String(err);
      console.error('[Strata] Tool execution error:', errorMsg, 'Action:', action);
      errors.push({
        action,
        message: errorMsg,
      });
      results.push({ action, status: 'failed', exitCode: -1, outputTail: '', message: errorMsg });
      // Show error notification for visibility
      vscode.window.showErrorMessage(`Strata tool error: ${errorMsg}`);
    }
  }

  return { applied, errors, results };
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const openChat = vscode.commands.registerCommand('strata.openChat', () => {
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'strataChat',
      'Strata',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableCommandUris: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      }
    );

    const astroOnDisk = vscode.Uri.joinPath(mediaRoot, 'astro.png');
    const astroSrc = panel.webview.asWebviewUri(astroOnDisk);

    const logoOnDisk = vscode.Uri.joinPath(mediaRoot, 'logo.png');
    const logoutOnDisk = vscode.Uri.joinPath(mediaRoot, 'logout.png');
    const microphoneOnDisk = vscode.Uri.joinPath(mediaRoot, 'microphone.png');
    const robotOnDisk = vscode.Uri.joinPath(mediaRoot, 'robot.png');
    const userOnDisk = vscode.Uri.joinPath(mediaRoot, 'user.png');
    const sendOnDisk = vscode.Uri.joinPath(mediaRoot, 'send.png');

    const logoSrc = panel.webview.asWebviewUri(logoOnDisk);
    const logoutSrc = panel.webview.asWebviewUri(logoutOnDisk);
    const microphoneSrc = panel.webview.asWebviewUri(microphoneOnDisk);
    const robotSrc = panel.webview.asWebviewUri(robotOnDisk);
    const userSrc = panel.webview.asWebviewUri(userOnDisk);
    const sendSrc = panel.webview.asWebviewUri(sendOnDisk);

    panel.webview.html = getWebviewHtml(
      String(astroSrc),
      String(logoSrc),
      String(logoutSrc),
      String(microphoneSrc),
      String(robotSrc),
      String(userSrc),
      String(sendSrc)
    );

    let currentAttachmentPath = null;
    let activeAgentKey = null;

    panel.webview.onDidReceiveMessage(async (message) => {
      if (!message || !message.type) {
        return;
      }

      if (message.type === 'activeAgentChanged') {
        const key = typeof message.agentKey === 'string' ? message.agentKey : '';
        activeAgentKey = key && AGENT_ROLE_PROFILES[key] ? key : null;
        return;
      }

      if (message.type === 'insertText') {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showInformationMessage('Open a file in the editor first.');
          return;
        }
        const text = typeof message.text === 'string' ? message.text : '';
        await editor.edit((editBuilder) => {
          editBuilder.insert(editor.selection.active, text);
        });
        return;
      }

      if (message.type === 'chat-attach-bytes') {
        try {
          const name = typeof message.name === 'string' ? message.name : 'attachment';
          const base64 = typeof message.data === 'string' ? message.data : '';
          const size = typeof message.size === 'number' ? message.size : 0;
          if (!base64) {
            return;
          }

          const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
          if (size && size > MAX_ATTACHMENT_BYTES) {
            vscode.window.showErrorMessage('Attachment too large (max 25MB).');
            return;
          }

          const buffer = Buffer.from(base64, 'base64');
          const tempDir = path.join(os.tmpdir(), 'strata-agent-attachments');
          await fs.promises.mkdir(tempDir, { recursive: true });
          const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
          const filePath = path.join(tempDir, Date.now() + '_' + safeName);
          await fs.promises.writeFile(filePath, buffer);

          currentAttachmentPath = filePath;
          panel.webview.postMessage({
            type: 'attachmentSelected',
            name,
          });
        } catch (err) {
          const msg = err && err.message ? String(err.message) : String(err);
          vscode.window.showErrorMessage(`Failed to attach file: ${msg}`);
        }
        return;
      }

      if (message.type === 'chat-attach') {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          openLabel: 'Select file for Gemini',
          filters: {
            'Documents & media': ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'txt', 'md'],
          },
        });

        if (!picked || picked.length === 0) {
          return;
        }

        currentAttachmentPath = picked[0].fsPath;
        panel.webview.postMessage({
          type: 'attachmentSelected',
          name: path.basename(currentAttachmentPath),
        });
        return;
      }

      if (message.type === 'clearAttachment') {
        currentAttachmentPath = null;
        return;
      }

      if (message.type === 'clearContextCache') {
        cachedWorkspaceContext = null;
        console.log('[Strata] Workspace context cache cleared via webview request.');
        return;
      }

      if (message.type === 'chat') {
        const raw = typeof message.text === 'string' ? message.text : '';
        const trimmed = raw.trim();
        if (!trimmed) {
          return;
        }
        const history = Array.isArray(message.history) ? message.history : [];
        const toolLog = Array.isArray(message.toolLog) ? message.toolLog : [];
        try {
          const workspaceContext = await getWorkspaceContextCached();
          if (currentAttachmentPath) {
            panel.webview.postMessage({ type: 'uploadStatus', status: 'uploading' });
          }
          const { text, tools } = await runGeminiChat(trimmed, currentAttachmentPath, history, workspaceContext, toolLog, activeAgentKey);
          panel.webview.postMessage({ type: 'uploadStatus', status: 'done' });
          console.log('[Strata] Gemini response - text length:', (text || '').length, 'tools count:', (tools || []).length);
          if (tools && tools.length > 0) {
            console.log('[Strata] Tools received:', JSON.stringify(tools));
          }
          currentAttachmentPath = null;
          panel.webview.postMessage({
            type: 'chatResponse',
            text: text || '',
            tools: Array.isArray(tools) ? tools : [],
          });
        } catch (err) {
          const msg = err && err.message ? String(err.message) : 'Unknown error';
          panel.webview.postMessage({ type: 'uploadStatus', status: 'done' });
          vscode.window.showErrorMessage(`Gemini chat error: ${msg}`);
          panel.webview.postMessage({ type: 'chatResponse', text: `Error from Gemini: ${msg}` });
        }
      }

      if (message.type === 'autoContinue') {
        const history = Array.isArray(message.history) ? message.history : [];
        const toolLog = Array.isArray(message.toolLog) ? message.toolLog : [];
        // Derive a short follow-up instruction so the model keeps working toward the last goal
        const followup = 'Continue the previous task automatically. Based on our last conversation and actions, propose the next concrete steps and strata-tools needed to move the project closer to done.';
        try {
          const workspaceContext = await getWorkspaceContextCached();
          const { text, tools } = await runGeminiChat(followup, currentAttachmentPath, history, workspaceContext, toolLog, activeAgentKey);
          currentAttachmentPath = null;
          panel.webview.postMessage({
            type: 'chatResponse',
            text: text || '',
            tools: Array.isArray(tools) ? tools : [],
          });
        } catch (err) {
          const msg = err && err.message ? String(err.message) : 'Unknown error';
          vscode.window.showErrorMessage(`Gemini auto-continue error: ${msg}`);
          panel.webview.postMessage({ type: 'chatResponse', text: `Error from Gemini while continuing: ${msg}` });
        }
      }

      if (message.type === 'applyTools') {
        const actions = Array.isArray(message.actions) ? message.actions : [];
        if (actions.length === 0) {
          return;
        }
        try {
          const { allowed, blocked } = filterActionsByRole(actions, activeAgentKey);
          const summary = await executeTools(allowed);
          if (blocked.length > 0) {
            for (const b of blocked) {
              summary.errors.push({ action: b.action, message: b.reason });
              summary.results.push({ action: b.action, status: 'failed', exitCode: -1, outputTail: '', message: b.reason });
            }
          }
          panel.webview.postMessage({ type: 'toolsApplied', summary });
        } catch (err) {
          const msg = err && err.message ? String(err.message) : 'Unknown error while applying tools';
          vscode.window.showErrorMessage(`Strata tools error: ${msg}`);
          panel.webview.postMessage({
            type: 'toolsApplied',
            summary: { applied: 0, errors: [{ message: msg }] },
          });
        }
      }
    });
  });

  context.subscriptions.push(openChat);
}

function getWebviewHtml(astroSrc, logoSrc, logoutSrc, microphoneSrc, robotSrc, userSrc, sendSrc) {
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src * blob: data: https:; img-src * blob: data: https: vscode-resource: vscode-webview:; media-src * blob: data: https:; style-src 'unsafe-inline' * blob: data: https:; script-src 'unsafe-inline' 'unsafe-eval' * blob: data: https:; connect-src * blob: data: https: wss:; worker-src * blob: data: https:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Strata Agents</title>
  <style>
    :root {
      /* VS Code will inject theme CSS variables */
      color-scheme: light dark;
      --agent-architect: #a855f7; /* Purple */
      --agent-coder: #3b82f6;     /* Blue */
      --agent-reviewer: #10b981;  /* Emerald */
      --agent-debugger: #ef4444;  /* Red */
      --agent-designer: #f59e0b;  /* Amber */
    }
    * {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
    }
    body {
      --strata-bg: var(--vscode-editor-background, #111111);
      --strata-panel: var(--vscode-editor-background, #111111);
      --strata-box: var(--vscode-editor-background, #111111);
      --strata-border: var(--vscode-editorGroup-border, var(--vscode-panel-border, #1f2937));
      --strata-accent: var(--vscode-button-background, #38bdf8);
      --strata-text-primary: var(--vscode-editor-foreground, #e5e7eb);
      --strata-text-muted: var(--vscode-descriptionForeground, #9ca3af);

      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--strata-bg);
      color: var(--strata-text-primary);
      overflow: hidden; /* Ensure border gradient doesn't scroll */
    }
    
    /* Apple Intelligence Border Effect */
    @property --angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    
    .apple-intelligence-border {
      position: fixed;
      inset: 0;
      z-index: 9999;
      pointer-events: none;
      border: 8px solid transparent;
      padding: 3px; /* To prevent cutting off */
      background: conic-gradient(from var(--angle), 
          #00C6FB, #005BEA, #DD2476, #FF512F, #FFD200, #FADB04, #00C6FB) border-box;
      mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      -webkit-mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      animation: rotate-gradient 4s linear infinite;
      opacity: 0;
      transition: opacity 1s ease-in-out;
      filter: blur(8px);
    }

    .apple-intelligence-border.active {
      opacity: 1;
    }

    @keyframes rotate-gradient {
      to {
        --angle: 360deg;
      }
    }

    /* Fallback animation for browsers not supporting @property */
    @keyframes rotate-gradient-fallback {
      0% { filter: hue-rotate(0deg) blur(8px); }
      100% { filter: hue-rotate(360deg) blur(8px); }
    }

    .root {
      height: 100%;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
    }
    .three-panels {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
    }
    .panel {
      flex: 1;
      min-height: 0;
      border-radius: 12px;
      padding: 10px 12px;
      background: var(--strata-box);
      border: 1px solid var(--strata-border);
      display: flex;
      flex-direction: column;
    }
    /* Shared Panel Styles */
    .panel-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 8px;
      color: var(--strata-text-muted);
    }
    
    /* PANEL 1: VOICE ROOM */
    .panel-top {
      /* equal height with other panels (no special flex override) */
    }
    .panel-top-content {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .panel-image-wrapper {
      flex-shrink: 0;
      width: 240px;
      height: 280px;
      border-radius: 12px;
      border: 1px solid var(--strata-border);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      background: var(--strata-box); /* Ensure contrast behind cuts */
    }
    .panel-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: all 0.3s ease;
    }
    .panel-image-wrapper:hover .panel-image {
      transform: scale(1.05); /* Subtle zoom for effect */
      filter: drop-shadow(0 6px 12px rgba(0,0,0,0.5));
      clip-path: url(#tech-mask);
      -webkit-clip-path: url(#tech-mask);
    }
    .music-toast {
      position: absolute;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%) translateY(10px);
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      padding: 4px 12px;
      border-radius: 99px;
      font-size: 10px;
      font-weight: 500;
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      pointer-events: none;
      white-space: nowrap;
      border: 1px solid rgba(255,255,255,0.1);
      z-index: 10;
    }
    .panel-image-wrapper:hover .music-toast {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .voice-column {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .voice-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .voice-title {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .voice-title-icon {
      width: 16px;
      height: 16px;
      border-radius: 4px;
      /* Make logo icon pop on both light/dark themes */
      filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.8)) brightness(1.35) contrast(1.1);
    }
    .voice-title-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--strata-text-muted);
    }
    .voice-status-pill {
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--strata-border);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      white-space: nowrap;
    }
    .voice-status-on {
      border-color: var(--strata-accent);
      color: var(--strata-accent);
    }
    .voice-status-off {
      opacity: 0.7;
    }
    .voice-main-row {
      margin-top: 2px;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .voice-main-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 28px;
      padding: 0 12px;
      border-radius: 100px;
      border: 1px solid var(--strata-text-primary);
      background: transparent;
      color: var(--strata-text-primary);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 0.15s ease-out, transform 0.1s ease-out, box-shadow 0.1s ease-out;
    }
    .voice-main-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      transform: translateY(-1px);
      box-shadow: 0 3px 8px rgba(0, 0, 0, 0.4);
    }
    @keyframes send-btn-pulse {
      0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); }
      70% { box-shadow: 0 0 0 6px rgba(59, 130, 246, 0); }
      100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
    }
    .chat-history-row {
      display: flex;
      align-items: center;
      width: 100%;
      border-radius: 4px;
      margin-bottom: 2px;
    }
    .chat-history-row:hover {
      background: var(--strata-bg-2);
    }
    .chat-history-item {
      flex: 1;
      text-align: left;
      background: none;
      border: none;
      color: var(--strata-text-2);
      padding: 6px 8px;
      cursor: pointer;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: 0.8;
    }
    .chat-history-item.active {
      color: var(--strata-blue);
      font-weight: 500;
      opacity: 1;
    }
    .chat-history-del-btn {
      background: none;
      border: none;
      color: var(--strata-text-3);
      cursor: pointer;
      padding: 6px;
      font-size: 14px;
      line-height: 1;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .chat-history-del-btn:hover {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.1);
      border-radius: 4px;
    }
    .chat-history-row:hover .chat-history-del-btn {
      opacity: 1;
    }
    .voice-main-btn:active {
      transform: translateY(0);
      box-shadow: none;
    }
    .voice-participants {
      margin-top: 2px;
      padding: 4px;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 170px;
      overflow-y: auto;
      overflow-x: hidden; /* prevent horizontal scrollbar in voice list */
      background: color-mix(in srgb, var(--strata-box) 92%, var(--strata-border) 8%);
      transition: border-color 0.18s ease, box-shadow 0.18s ease;
    }
    .voice-participants.drop-ready {
      border: 1px dashed color-mix(in srgb, var(--strata-accent) 70%, transparent 30%);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--strata-accent) 20%, transparent 80%);
    }
    .voice-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 4px 6px;
      border-radius: 6px;
      border: 1px solid var(--strata-border);
      font-size: 11px;
      color: var(--strata-text-primary);
      background: color-mix(in srgb, var(--strata-box) 94%, var(--strata-border) 6%);
    }
    .voice-card.me {
      /* Highlight the local user with a theme-aware blend instead of a single hard color */
      background: color-mix(in srgb, var(--strata-box) 85%, var(--strata-accent) 15%);
      color: var(--strata-text-primary);
    }
    .voice-card.muted {
      opacity: 0.65;
    }
    .voice-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .voice-avatar {
      width: 20px;
      height: 20px;
      border-radius: 999px;
      background: radial-gradient(circle at top, var(--strata-accent), transparent 70%);
      border: 1px solid var(--strata-border);
      flex-shrink: 0;
      overflow: hidden;
    }
    .voice-avatar-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      /* Ensure user/agent icons are visible on extreme light/dark themes */
      filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.85)) brightness(1.7) contrast(1.25);
    }
    .voice-text {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .voice-name {
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
      color: inherit;
    }
    .voice-role {
      font-size: 10px;
      color: var(--strata-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .voice-card.me .voice-role {
      color: var(--strata-text-muted);
    }
    .voice-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .voice-icon-btn {
      position: relative;
      border: 0;
      background: transparent;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
    }
    .voice-icon-btn::after {
      content: attr(data-label);
      position: absolute;
      bottom: 125%;
      left: 50%;
      transform: translateX(-50%) translateY(0);
      padding: 2px 6px;
      border-radius: 4px;
      background: color-mix(in srgb, var(--strata-box) 80%, #000000 20%);
      color: var(--strata-text-primary);
      font-size: 9px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.12s ease-out, transform 0.12s ease-out;
      z-index: 10;
    }
    .voice-icon-btn:hover::after {
      opacity: 1;
      transform: translateX(-50%) translateY(-2px);
    }
    .voice-icon-img {
      width: 18px;
      height: 18px;
      object-fit: contain;
      display: block;
      /* Base contrast so icons are visible across themes */
      filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.8)) brightness(1.7) contrast(1.2);
    }
    /* Make the chat mic icon a bit larger and higher contrast, without affecting voice room icons */
    #chat-mic-btn .voice-icon-img {
      width: 22px;
      height: 22px;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.9)) brightness(2.1) contrast(1.4);
    }

    /* PANEL 2: SPACE TWO */
    .panel-middle {
      /* slightly shorter than other panels to give more space to chat */
      flex: 0.7;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .panel-sub {
      font-size: 12px;
      color: var(--strata-text-muted);
    }
    .agents-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      padding: 4px 0;
    }
    .agent-card {
      position: relative;
      border: 1px solid var(--strata-border);
      border-radius: 8px;
      padding: 10px 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      cursor: grab;
      transition: all 0.2s ease-out;
      overflow: hidden;
      background: var(--strata-box);
      background: color-mix(in srgb, var(--strata-box) 88%, var(--strata-border) 12%);
    }
    .agent-card:active {
      cursor: grabbing;
    }
    .agent-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      border-color: var(--agent-color);
    }
    .agent-card.selected {
      background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.08) 100%);
      border-color: var(--agent-color);
      box-shadow: 0 0 0 1px var(--agent-color), 0 8px 20px -4px rgba(0,0,0,0.5);
    }
    .agent-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--agent-color);
      opacity: 0.7;
    }
    .agent-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      color: var(--agent-color);
    }
    .agent-info {
      text-align: center;
    }
    .agent-name {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 2px;
      color: var(--strata-text-primary);
    }
    .agent-role {
      font-size: 9px;
      color: var(--strata-text-muted);
      line-height: 1.2;
    }
    .agent-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--strata-border);
      margin-top: 4px;
      transition: background 0.2s;
    }
    .agent-card.selected .agent-status-dot {
      background: var(--agent-color);
      box-shadow: 0 0 8px var(--agent-color);
    }
    
    .dispatch-box {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: auto;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid var(--strata-border);
      background: var(--strata-box);
      background: color-mix(in srgb, var(--strata-box) 92%, var(--strata-border) 8%);
    }
    .dispatch-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--strata-text-muted);
      display: flex;
      justify-content: space-between;
    }
    .dispatch-input {
      background: transparent;
      border: 0;
      border-bottom: 1px solid var(--strata-border);
      padding: 6px 0;
      color: var(--strata-text-primary);
      font-family: inherit;
      font-size: 12px;
      outline: none;
      transition: border-color 0.2s;
    }
    .dispatch-input:focus {
      border-color: var(--strata-accent);
    }
    .dispatch-input::placeholder {
      color: var(--strata-text-muted);
      opacity: 0.5;
    }

    /* PANEL 3: CHATBOX (Bottom) */
    .panel-bottom {
      /* give chat a bit more height than the other panels */
      flex: 1.3;
      display: flex;
      flex-direction: column;
      min-height: 0;
      position: relative;
      /* keep all chat content visually inside this panel; inner list scrolls instead */
      overflow: hidden;
    }
    .panel-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .panel-title-row .panel-title {
      margin-bottom: 0;
    }
    .chat-header-actions {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-shrink: 0;
    }
    .chat-header-btn {
      border: 1px solid var(--strata-border);
      background: color-mix(in srgb, var(--strata-box) 85%, var(--strata-border) 15%);
      color: var(--strata-text-muted);
      border-radius: 8px;
      padding: 3px 8px;
      font-size: 10px;
      cursor: pointer;
      line-height: 1;
    }
    .chat-header-btn:active {
      transform: translateY(0.5px);
    }
    .chat-history-popover {
      position: absolute;
      top: 40px;
      right: 12px;
      z-index: 50;
      width: 240px;
      max-height: 260px;
      overflow: auto;
      border-radius: 12px;
      border: 1px solid var(--strata-border);
      background: color-mix(in srgb, var(--strata-box) 92%, var(--strata-border) 8%);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      padding: 8px;
      display: none;
    }
    .chat-history-item {
      width: 100%;
      text-align: left;
      border: 1px solid var(--strata-border);
      background: transparent;
      color: var(--strata-text-primary);
      border-radius: 10px;
      padding: 6px 8px;
      cursor: pointer;
      font-size: 11px;
      margin-bottom: 6px;
    }
    .chat-history-item:last-child {
      margin-bottom: 0;
    }
    .chat-history-item.active {
      border-color: var(--strata-accent);
    }
    .chat-root {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
      /* allow chat-messages to shrink and handle its own scroll */
      min-height: 0;
    }
    .chat-messages {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 2px 0;
      overflow-y: auto;
      font-size: 12px;
    }
    .chat-message {
      max-width: 100%;
      border-radius: 10px;
      padding: 6px 8px;
      word-wrap: break-word;
      white-space: pre-wrap;
      border: 1px solid var(--strata-border);
      background: var(--strata-box);
    }
    .chat-message.user {
      align-self: flex-end;
      border-color: var(--strata-accent);
      background: color-mix(in srgb, var(--strata-box) 85%, var(--strata-accent) 15%);
    }
    .chat-message.assistant {
      align-self: flex-start;
      background: color-mix(in srgb, var(--strata-box) 92%, var(--strata-border) 8%);
      white-space: normal;
    }
    .chat-message.assistant b, .chat-message.assistant strong {
      font-weight: 700;
    }
    .chat-message.assistant pre {
      white-space: pre-wrap;
      word-break: break-all;
    }
    .chat-message.assistant.thinking {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 10px;
    }
    .chat-thinking-dots {
      display: inline-flex;
      gap: 4px;
    }
    .chat-thinking-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--strata-text-muted);
      animation: chat-thinking-bounce 1s infinite ease-in-out;
    }
    .chat-thinking-dots span:nth-child(2) {
      animation-delay: 0.15s;
    }
    .chat-thinking-dots span:nth-child(3) {
      animation-delay: 0.3s;
    }
    @keyframes chat-thinking-bounce {
      0%, 80%, 100% {
        opacity: 0.2;
        transform: translateY(0);
      }
      40% {
        opacity: 1;
        transform: translateY(-1px);
      }
    }
    /* --- AGENT UI STYLES (Redesign) --- */
    .agents-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px; /* Reduced gap */
      padding: 10px; /* Reduced padding */
      justify-content: center;
      align-items: flex-start;
      overflow-x: hidden; /* Prevent horizontal overflow */
    }

    .agent-card {
      position: relative;
      width: 100px; /* Reduced width */
      height: 140px; /* Reduced height */
      background: rgba(30, 30, 35, 0.6);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 16px; /* slightly smaller radius */
      border: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 8px; /* Reduced padding */
      cursor: pointer;
      transition: all 0.5s cubic-bezier(0.23, 1, 0.32, 1);
      overflow: hidden;
      /* Removed heavy shadow causing "glow" look on base card if any */
      box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
    }

    .agent-card:hover {
      transform: translateY(-3px);
      background: rgba(40, 40, 45, 0.8);
      border-color: rgba(255, 255, 255, 0.2);
      /* Subtle shadow, no glow */
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }

    /* Avatar Container */
    .agent-avatar {
      width: 60px; /* Reduced avatar size */
      height: 60px;
      border-radius: 50%;
      background: rgba(255,255,255,0.05);
      border: 2px solid rgba(255,255,255,0.1);
      overflow: hidden;
      margin-bottom: 12px; /* Reduced margin */
      transition: all 0.5s cubic-bezier(0.23, 1, 0.32, 1);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      z-index: 2;
    }

    .agent-avatar svg {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scale(1.1); /* Zoom in slightly on illustration */
    }

    /* Text Details */
    .agent-details {
      display: flex;
      flex-direction: column;
      align-items: center;
      max-height: 100px;
      opacity: 1;
      transform: translateY(0);
      transition: all 0.4s ease;
    }

    .agent-role {
      font-size: 10px; /* Reduced font size */
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
      letter-spacing: 0.02em;
    }

    .agent-name {
      font-size: 9px; /* Reduced font size */
      color: rgba(255,255,255,0.5);
      font-weight: 400;
      text-align: center;
      line-height: 1.2;
      max-width: 90px; /* Constrain width */
    }

    /* SELECTED / ONLINE STATE */
    .agent-card.selected {
      width: 70px;
      height: 70px;
      border-radius: 50%;
      background: var(--agent-color);
      /* REMOVED GLOW BOX SHADOW */
      box-shadow: none; 
      border-color: transparent;
      padding: 0;
    }

    .agent-card.selected .agent-avatar {
      width: 100%;
      height: 100%;
      margin-bottom: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
    }

    .agent-card.selected .agent-details {
      opacity: 0;
      transform: translateY(20px);
      pointer-events: none;
      position: absolute;
      width: 0;
      height: 0;
      overflow: hidden;
    }

    /* Thinking Animation dots */
    .thinking-dots {
      position: absolute;
      bottom: 10px;
      display: none;
      gap: 3px;
      z-index: 10;
    }
    .agent-card.thinking .thinking-dots { display: flex; }
    
    .thinking-dots span {
      width: 4px;
      height: 4px;
      background: #fff;
      border-radius: 50%;
      animation: agent-think 1s infinite ease-in-out;
    }
    .chat-tools-panel {
      margin-top: 4px;
      align-self: stretch;
      border-radius: 8px;
      border: 1px dashed var(--strata-border);
      padding: 6px 8px;
      background: color-mix(in srgb, var(--strata-box) 96%, var(--strata-border) 4%);
      font-size: 10px;
      color: var(--strata-text-muted);
    }
    .chat-tools-title {
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-size: 9px;
      margin-bottom: 4px;
    }
    .chat-tools-list {
      margin: 0 0 6px 0;
      padding-left: 14px;
    }
    .chat-tools-list li {
      margin: 0;
      padding: 0;
    }
    .chat-tools-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
    }
    .chat-tools-btn {
      border-radius: 999px;
      border: 1px solid var(--strata-border);
      padding: 2px 8px;
      font-size: 10px;
      background: transparent;
      color: var(--strata-text-muted);
      cursor: pointer;
    }
    .chat-tools-btn.primary {
      border-color: var(--strata-accent);
      color: var(--strata-accent);
    }
    .chat-input-row {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 22px;
      border-radius: 14px;
      margin-top: auto;
      border: 1px solid var(--strata-border);
      background: var(--strata-box);
      background: color-mix(in srgb, var(--strata-box) 90%, var(--strata-border) 10%);
      min-height: 96px;
    }
    .chat-icon-btn {
      border: 0;
      background: transparent;
      color: var(--strata-text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      cursor: pointer;
    }
    .chat-input-shell {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .chat-input-field {
      border: 0 !important;
      padding: 0;
      margin: 0;
      background: transparent;
      color: var(--strata-text-primary);
      font: inherit;
      outline: none;
      width: 100%;
      line-height: 1.4;
      box-shadow: none !important;
      -webkit-appearance: none;
      appearance: none;
      resize: none;
      overflow-y: auto;
      min-height: 22px;
      max-height: 140px;
    }
    .chat-input-field:focus {
      outline: none;
      border: 0 !important;
      box-shadow: none !important;
    }
    .chat-input-field::placeholder {
      color: var(--strata-text-muted);
    }
    .chat-input-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 10px;
      color: var(--strata-text-muted);
      margin-top: 16px;
    }
    .chat-input-mode {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .chat-input-model {
      opacity: 0.9;
    }
    .chat-attachment-label {
      margin-left: auto;
      max-width: 120px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .upload-status {
      display: none;
      align-items: center;
      gap: 4px;
      margin-left: 6px;
      font-size: 10px;
      color: var(--strata-accent);
    }
    .upload-status.active {
      display: inline-flex;
    }
    .upload-spinner {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(255,255,255,0.2);
      border-top-color: var(--strata-accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .upload-status.done .upload-spinner {
      display: none;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .chat-send-btn {
      border-radius: 999px;
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #ffffff;
      border: 1px solid #ffffff;
      cursor: pointer;
      padding: 0;
      transition: background 0.2s, border-color 0.2s;
    }
    .chat-send-btn.working {
      background: #ef4444;
      border-color: #ef4444;
    }
    .chat-send-btn.working .chat-send-icon {
      display: none;
    }
    .chat-send-btn.working .chat-stop-icon {
      display: block;
    }
    .chat-send-icon {
      width: 14px;
      height: 14px;
      object-fit: contain;
      display: block;
      filter: invert(0) brightness(0) contrast(1.2);
    }
    .chat-stop-icon {
      width: 10px;
      height: 10px;
      background: #ffffff;
      border-radius: 2px;
      display: none;
    }
    @keyframes send-btn-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .chat-send-btn.working {
      animation: send-btn-pulse 1s ease-in-out infinite;
    }
  </style>
</head>
<body>
  <!-- SVG DEF for Masking -->
  <svg width="0" height="0" style="position: absolute; pointer-events: none;">
    <defs>
      <clipPath id="tech-mask" clipPathUnits="objectBoundingBox">
        <path d="M 0.08 0 L 0.92 0 L 1 0.08 L 1 0.92 L 0.92 1 L 0.08 1 L 0 0.92 L 0 0.55 L 0.03 0.5 L 0 0.45 L 0 0.08 Z">
          <animate attributeName="d" 
            values="M 0.08 0 L 0.92 0 L 1 0.08 L 1 0.92 L 0.92 1 L 0.08 1 L 0 0.92 L 0 0.35 L 0.03 0.3 L 0 0.25 L 0 0.08 Z;
                    M 0.08 0 L 0.92 0 L 1 0.08 L 1 0.92 L 0.92 1 L 0.08 1 L 0 0.92 L 0 0.75 L 0.03 0.7 L 0 0.65 L 0 0.08 Z;
                    M 0.08 0 L 0.92 0 L 1 0.08 L 1 0.92 L 0.92 1 L 0.08 1 L 0 0.92 L 0 0.35 L 0.03 0.3 L 0 0.25 L 0 0.08 Z" 
            dur="8s" 
            repeatCount="indefinite"
            calcMode="spline"
            keyTimes="0;0.5;1"
            keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" />
        </path>
      </clipPath>
    </defs>
  </svg>
  <div class="root">
    <div class="three-panels">
      
      <!-- 1. VOICE ROOM -->
      <section class="panel panel-top">
        <div class="panel-top-content">
          <div class="panel-image-wrapper" onclick="playMusic(this)" style="cursor: pointer; position: relative;">
            <img id="voice-room-img" src="${astroSrc}" alt="Strata illustration" class="panel-image" />
            <div class="music-toast">Click to start music</div>
          </div>
          <div class="voice-column">
            <div class="voice-header-row">
              <div class="voice-title">
                <img src="${logoSrc}" alt="Strata" class="voice-title-icon" />
                <div class="voice-title-label">Voice room</div>
              </div>
              <div class="voice-status-pill voice-status-off" id="voice-status-pill">Disconnected</div>
            </div>
            <div class="voice-main-row">
              <button class="voice-main-btn" id="voice-main-btn">Join voice</button>
            </div>
            <div class="voice-participants" id="voice-participants"></div>
          </div>
        </div>
      </section>

      <!-- 2. AGENT DISPATCH (Active UI) -->
      <section class="panel panel-middle">
        <div class="panel-title">Agent Dispatch</div>
        
        <div class="agents-grid">
          <!-- ARI -->
          <div class="agent-card" id="agent-architect" data-agent-key="architect" draggable="true" style="--agent-color: #a855f7">
             <div class="agent-avatar" id="av_ari"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1744 1744" fill="none" shape-rendering="auto"><metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:RDF><rdf:Description><dc:title>Notionists</dc:title><dc:creator>Zoish</dc:creator><dc:source xsi:type="dcterms:URI">https://heyzoish.gumroad.com/l/notionists</dc:source><dcterms:license xsi:type="dcterms:URI">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>Remix of „Notionists” (https://heyzoish.gumroad.com/l/notionists) by „Zoish”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id="viewboxMask"><rect width="1744" height="1744" rx="0" ry="0" x="0" y="0" fill="#fff" /></mask><g mask="url(#viewboxMask)"><g transform="translate(531 487)"><path d="M554 727.7c-99.2 297-363.8 388.6-503.7 19.8-19.3-50.7 31-69.5 66.2-91.9 24.1-15.3 36.8-28.5 35.3-42.2-7-64.4-36.9-243.8-36.9-243.8l-3-5.8s.7-1.6-2.2 1.2c-3 3-9.9 34.2-37 34.2-24.5 0-49.2-10.9-61-86.3C7.2 285.6 9.6 214 40 201c12.5-5.3 24-7.2 35.2-.8 11.3 6.4-13-22 112-126C268.4 6.4 396.7-3.5 448.5 8 500.3 19.5 552 44.8 574.9 98.5c27.8 65-25.9 114.3-14 262.5-2.2 53.6.8 171.2-146.6 210.6-28 7.5-19.3 48.4 22.7 58.4 67 21 117 72.3 117 97.9" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="m554 266.2.1-1.4c4.1-36.4 8.2-71.7 27.1-103.4 6.5 4.4 5.7 10 3.7 15.2-19.9 51.2-18 104.4-16.2 157.6l.4 14c2.1 66.4-14.5 126.8-58.7 177.5-15.4 17.6-35.8 29.8-56.5 40.3-21.4 11-25.9 20.1-19.2 43.6l.8 2.6c1.4 3.9 2.8 7.9-1 11.8-4.5 4.6-9.5 3.3-14.8 1.8l-.6-.1a406.4 406.4 0 0 1-137-68.3c-6-4.4-10.8-10.3-15.5-16.1l-.3-.4c-2.5-3-3-7.8.5-10.4 3.3-2.5 5.8-.5 8.7 1.8l1 .9a145.5 145.5 0 0 0 76.3 31.7c13.4 1.4 26.6.9 40 .4 7.4-.3 14.8-.6 22.3-.5 10.2 0 18.7-4.7 26.7-9.2l2.8-1.6c27.8-15.5 54.3-32.8 72.2-60.7 16.1-25 25.9-52.2 31.6-80.9 7.2-36.1 6.6-72.7 6-109.8-.3-12-.5-24.2-.5-36.4ZM50.6 190.8c21.9-1.7 34 11.2 44.3 26.3a140.4 140.4 0 0 1 22.4 61.5c.5 3.7 1 7.6-1.2 11.3-4.5.6-4.9-3-5-5.6-.5-20.7-9.7-38.7-18.9-56.1-6.6-12.5-16.2-24.6-31.4-27.6-17.2-3.5-33 12-40.8 32.2-14.5 37.6-12 74.6 1.4 111 5.8 15.9 13.1 32.1 27.8 43.2 14.8 11.3 32.7 9.3 43.6-5.7l2-2.5c2-2.6 4-5.1 5-8 2.1-5.8 5.4-11.2 11.3-10.4 6.8 1 8 8.3 8.7 14a3661 3661 0 0 0 22 156.7l5.9 38.8c2.6 17.1 5.6 41.7 3.6 52.1a28 28 0 0 0-.3 2.2c-.4 2.8-.6 5-4.2 5.5-4.9.8-7-2-7.7-6.4-2.3-17-3-23.6-4-49.6-.9-25.2-5.6-50-10.4-74.9l-5-27c-5.2-30.8-10.3-62-10.8-97l-2 3c-7.6 11.3-13.7 20.5-24.5 24a40.5 40.5 0 0 1-46.1-12.5 127.8 127.8 0 0 1-28.8-55.8c-8.4-34-9.9-67.1.9-100.6 5.2-16.1 23.7-44.7 42.2-42Zm34.6 127.5c4.4 3.2 8.4 6 12-5.4-1.1-42.2-14.7-69.2-35.8-70.3 11.2 14.6 22 28.8 23 48.5a32.3 32.3 0 0 1-10.7-8.8c-2-2.2-4-4.4-6.5-6l-3-2.4c-4.8-3.6-9.7-7.4-17.8-4.5 3.8 5.8 9 10 14.3 14 6 4.7 12 9.3 15.6 16.5-10.6 7.7-15.2 17.7-9.7 29.9 4.8 10.5 11.9 19.2 25.9 19.8-.6-6.3-4.7-10.9-8.8-15.4-5-5.4-9.7-10.6-7.5-18.6 3.2-1.5 6.2.7 9 2.7Z" fill="#000"/></g><g transform="translate(178 1057)"><path d="M1294.6 717H83.4l8.6-63.2S14.3 627.3 6.5 612c-7.8-15.3 84.3-214 97-245.4 12.6-31.5 76.6-148 135.7-174 39.7-17.3 137.8-75.2 175-91.5C419 99 431 81 438.6 68c7.6-13.2 15.7 13.4 42-28.5 6.7-10.6 34.7 7 50.7 17.3 13.6 9 36.7 44.5 142.6 37.8C817.5 85.7 837 19.3 853.6 29c24 14 53.8 56.5 53.8 56.5s109.8 69 138.7 91.6c59.5 46.4 123.1 81.9 180.6 251.6 19.9 58.6 78 160.2 86 173.2 8.2 13.1-27 36-27 36l8.9 79.1Z" fill="#fff"/><path d="M1063.5 198.7c-30.2-25.3-60-47-93.8-66.2-2.3-1.3-4.7-3.4-7.4-1.2-3.7 3.2-2.5 7.6-1.5 11.7 6.1 24.7.6 46.4-15.4 63.8a85.1 85.1 0 0 1-36 22.7c-9.3 3-12.6 8-9.8 19.7 5.4 21.8 11.7 43.1 11.2 66.9-.7 29-12.8 49.6-29.5 68.8-23 26.6-53.7 35.9-83.7 46.8a383.3 383.3 0 0 0-90.2 45.3c-15.2 10.7-23 30-30.6 48a292.5 292.5 0 0 0-18.6 77.1c-2.5 18.7 6 34.8 9.7 52 5 23.3 14.4 44.4 30.3 62-3.9.9-7.7.9-12.6.9a182.8 182.8 0 0 1-36-137.3c5.3-39.8 18.7-76.8 45.6-105.2 16-17 36.4-26.8 56.3-37 28.7-14.6 60-22.2 88.5-37 29-15.2 51.2-39.3 55.6-79a164 164 0 0 0-6.6-61c-5-19-.5-31.3 16.5-42 9.4-6 19.7-9.4 28.3-18a53 53 0 0 0 17.3-32.9c2.8-27.8-2-51.7-22.2-66.3-11.7-8.4-16-8-25.6 3.3-3.8 4.4-7.2 9-13.4 5.7-1.7-2.1-.3-4 .5-5.8 2.8-5.6 10.7-8.8 8.2-17-3.2-10.7-6.4-22-15.4-28.9-6.4-4.8-13-6.4-20-1.7-3.3 2.2-6.5 4.5-10 6-1.4.6-3 .6-4.5 0-1.4-.7-2.5-2-3.1-3.6-1.6-3.6.6-5.3 2.8-7.2 3.6-3 7-6.2 11-10-6.4-8-12.1-5.6-18-.9-10.3 8.4-20 18.1-31 24.8a211.2 211.2 0 0 1-100 31.7c-33.9 1.4-67.8 3.2-101.6.8C587 96.9 567.2 87 547.3 78c-16.4-7.4-31-18.4-46.8-27.1-13.5-7.4-20.5-4.6-28 10-9.5 18.5-7 33.2 8.6 49.4 3.6 3.8 11.3 7.6 7.2 13.5-5 7-10.2-1.5-14.1-4.9-10.8-9.4-20-20.4-21.1-37-.3-4-.5-8-5.2-8.5-3.6-.4-6 .9-8.5 4.5-8.2 12.4-8 18.6 3 36.7 2.5 4.3 5.8 8 2.2 14.2-11-4.8-14.8-17.1-20.7-27.2-6.6 5.5-4.4 11-2.9 16a147.9 147.9 0 0 0 62.4 81.8c13.7 9 27.5 18 42.7 22.9 36.4 11.6 72.3 26.3 111.4 23.3 25.9-2 52.2 3 77.7-6.3 6.7-2.4 9.2 2.5 8.5 9.1-2.5 26.3-7.4 51.7-21.2 74-22.7 36.6-55.2 59.4-88.8 80.6-25.8 16.3-54.8 25.3-79 45.5a190.8 190.8 0 0 0-46.5 54.3C465.5 544 462 588.6 471.9 635c5.2 24.8 19.8 43.2 34.4 61.4 5.3 6.6 11.2 12.7 17 19.8-3.8.9-7.7.9-12.5.9-24.9-24.6-46.3-51-53.4-88.3a217 217 0 0 1 .3-77.2c7.8-46 30.5-81.7 62.1-110.1 14.8-13.2 31-24 48.4-32.2 43.2-20.5 83.2-46.6 115.5-85.8a105 105 0 0 0 23.8-63.6H632c-27.8 0-54.3-7-80.8-15.8a296 296 0 0 1-70.4-33 163 163 0 0 1-66.8-82.4c-3.2-9-6.4-10.2-13.3-5.7-27.6 17.7-57.8 28.4-86.6 42.9-49.3 24.8-101.5 44.3-137.1 94.5a789 789 0 0 0-45.2 71.5C103.4 382.6 82.1 437.6 58 491c-13 28.6-26.3 57-37.6 86.5-9 23.4-7.5 27.2 14.7 34 13.4 4 26.3 11.1 40 13.5 36.2 6.4 68.5 24.7 101.7 40.3a530 530 0 0 1 77.1 41.6c4.9 3.4 11.4 2.2 15 9.2-9.6.8-19.2 1-28.8.3-45.3-26-93-39.7-138.8-62-5 23-10.7 42.1-11.6 62.6H77.1c-2.8-9.2.5-17.6 2.1-26.3 2.1-11.3 1.2-19.6-11.4-22-20.5-4-37.4-17.3-54.6-29.4-12.1-8.4-16-26.2-11.3-47 5.5-25 15.6-47.6 25.5-70.5 20.5-47.5 42-94.5 63.2-141.6 25.8-57 55.5-112 97.7-156.2 21-22 45.2-38.4 71.6-51.9 22.8-11.7 45.6-23.8 69-33.8 20-8.7 39-19.6 58.7-29 14.6-6.9 28.3-14.7 36-32.2 6.1-13.8 15.5-24.6 31.5-20.1 4.2 1.2 6-1.6 8.1-5 16-24.3 28-26.8 51.8-11.2 6.6 4.3 42.5 24.2 53 29.5 23.8 12 49.6 18 75.7 17.8 26.4-.2 52.8-2.6 79.1-4.5C753.8 81.4 782 68 809 52c9.8-5.8 18.4-14.6 27.8-21.6 11.3-8.4 23.5-6.9 33.5 3.9 4 4 8.3 7.3 13.2 9.7 13.1 7 17.5 24.3 27.8 32 10.4 7.7 25.2 7.9 34.6 20.6 6.3 8.6 16.4 11.6 25 17 248.7 157.4 198.5 193.2 296.6 375.9 17.1 31.9 29.5 66.4 46.1 98.5.2.3.3.7.6 1 16.3 27 13.1 39.2-14 52.2-7.1 3.4-10.8 6.6-9 16.9 3.3 18.7 4.7 37.8 6.7 57.8-4 1-8 1-13.1 0-4.2-10.9-3.7-21.1-3.7-31.3-.2-17.7-5.8-33.8-10.4-51.4-10.2 4-20 6.2-28.4 11.1-27 15.8-55 27.2-85 33-15.1 3-21.7 13.5-21.7 30.9.2 3 .5 5.9 1 8.8-5.1.1-10.2-.3-15.2-1.2-2.6-76 172-113.3 172-113.3s-32.1-68.2-55.2-126.2c-26.7-67.2-42.4-95.4-57.5-133.3-23.2-58.5-113.7-141.4-117.1-144.3Z" fill="#000"/><path d="M523.3 613.7c-10.3-30-7.6-58 5.5-85.1l5.3-11.2c2-4.7 5.2-8 9.8-5.6 4.4 2.2 3 6.6 1.7 11-3.4 12-9.4 22.8-12.7 35-7.8 29.1.5 53 16 75 6.4 9 14.9 16.3 16.1 29.2a88.3 88.3 0 0 1-41.7-48.3ZM829.8 163c16.4-22.2 34-33.7 45.2-29a35 35 0 0 1-11.2 12 133.7 133.7 0 0 0-38 39.3c-15.3 22.7-15.8 46.3-2.4 70.6a97.5 97.5 0 0 1 11.5 40.8c1.2 16.6-5.4 28.5-19.8 35.3-.5-.7-1.3-1.7-1.2-2 15.4-21.9 9-44.4 1.6-67-11.5-35.8-8.3-69.3 14.3-100Z" fill="#000"/></g><g transform="translate(266 207)"><g fill="#000"><path d="M890.2 299.7c7.5 37-1.8 77.7-15 112.3-7.4 19.3-20.2 42-31.3 54.3-9.2-2.8-14-14.4-18.3-19.8A116.1 116.1 0 0 0 756 404c-36.6-8.2-72.7-3.6-109.1-.4-31.8 2.8-63.7 5-95.6 5.8-15.6.3-31.1 5.4-47 1-1.9-.5-5.2 1-6.8 2.6-17.2 17.8-39 30-56.8 47.2-18.9 18-25.2 41-26.4 65.6-.7 16-4.4 31-7.7 46.4-2.7 13-13 12.7-21.9 12.4-9.8-.3-6.7-9.5-8.4-15.6-8.6-29.5-11.9-61.4-37.6-83-3.9-3.3-8.2-7.7-12.7-8.1-12.5-1.3-13.5-9-13.5-18.7 0-24.7-26-41.5-24.2-66 3.6-47 41.8-98.4 72.9-135.2a130 130 0 0 1 61.2-40.9 540 540 0 0 1 87-22.7c43.5-6.3 87.4-12.7 131.6-4.6a160 160 0 0 0 35.6 3c35.4-1.6 68 8.2 100 21.9 8.9 3.8 18 24.6 27 27.8"/><path d="M404.2 295c10.3 9.5 20.8 17.4 27.7 29 12 20-3.7 57-22.3 70.1a645.4 645.4 0 0 0-31.4 23.7c-7.5 6-13 5.4-19.7-1.6a231.2 231.2 0 0 1-44.3-69.2 416 416 0 0 1-28.4-84.1 56.9 56.9 0 0 1 .1-27.8c3.7-12.4 10.8-15.7 22.1-9.7 35 18.6 67.4 40.8 96.2 69.5ZM786.3 279.7c-2.2 7.5-4.7 13.9-5.8 20.5-4.1 24.7-12 30.7-34.2 21a164.5 164.5 0 0 1-51.9-33.4c-18.4-18.4-16.3-21.8-3.7-45.4 16-30 42.1-51.6 65.2-75.8 12-12.5 24-25.1 38.5-34.8 5.7-3.7 12.8-9.8 19.7-5.3 7.6 4.9 6.6 13.6 5.1 22a612 612 0 0 1-19.4 84c-4.8 15-11.7 30-13.5 47.2ZM565.4 190.1a740.6 740.6 0 0 1 28.5-99.7c.7-2 .7-4.6 2-5.9 5.9-5.8 7.8-17 17.7-16.8 10.1.2 10.9 11 14 17.9 12 27.3 15.8 57 21.2 86 4.6 24.9 9.9 49.8 11.1 75.4.6 12-2.6 18.7-16 20.6-16.3 2.4-31.7 9.3-48.6 9.2-10.6 0-21-2.7-30.3-7.8-12.5-6.6-15.5-16.4-12.8-28.6 3.7-16.6 8.5-32.9 13.2-50.3ZM435.4 248c-5.3-41.5-15-81.4-12.9-122.6.3-5.6 0-11.7 6.8-13.6 6-1.8 11.6-.7 16.2 4.4 18.4 21 35.4 43.3 50.7 66.7 11.6 17.7 23.4 35.3 33.2 54.2 11.2 21.6 10.3 35.5-6 52a75.4 75.4 0 0 1-44.6 22c-28 3.8-32.4-10.6-37.6-32.2-2.4-9.6-3.8-20-5.8-31ZM360.3 478.3c-.3 6.9 1 12.8-1.7 18.5-15.3-9-27.2-22.9-46.2-20.4-2.5.3-5.6-.3-7.5.9-12.7 7.9-20.2-.1-26.7-8.9a370 370 0 0 1-50.2-87.8c-2.5-6.5-5.4-14 .5-19s13.2-2.2 20.3.5a332.7 332.7 0 0 1 78 44.6c10.8 8 21.9 16 31.2 25.6a24.8 24.8 0 0 1 6 25c-2 6.5-4 13-3.7 21ZM866.4 350c-5.2 11.8-12.9 20.9-20.1 30.2-7 9-15 9.2-23 2-13.3-12-23.2-26.9-30.5-43.1-4.2-9.3-2.7-19.6 5.4-25.8 25.4-19.3 46.4-43.5 72-62.5 12.5-9.3 24.7-19.2 38.7-26.3 4.1-2.1 8.6-4.5 13-.4 4.3 3.9 3.2 8.7 1.2 13-12 25-24 50.2-36.4 75.2-6.2 12.5-13.2 24.7-20.3 37.7Z"/></g></g><g transform="translate(791 871)"><path d="M176 65c-3.3-2.8-6.4-5.1-11.4-2.8-7.9 3.6-16.1 6.5-24.3 9.8 8.5 11.3 17.4 21.9 23.8 34.4 4.2 8.3 11.8 14.4 22 10.5 9.4-3.5 9.3-12.6 8.4-20.7A42.6 42.6 0 0 0 176 65Z" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="M209 98v-4.9c1-6.4-.6-11.9-2-16.6l-1.3-5.2c3-5.6 7-3.3 10.7-1.1 4 2.3 7.5 4.3 9.2-2.9 1.8-7.2-2-15.5-10.5-20.3-7.8 8.7-16.3 7.7-25.4 2.7C183.2 46 176 44 169 47.3c-11 5-22.8 6.5-34.6 8.1L123 57l-2.5.4c-11.3 2-22.5 3.9-32.7-4.6-3.4-2.8-7.4-1-10.4 1.9-3 3-4 6.6-2.1 10.4 1.6 3.2 4 4.7 8.1 4.8 23.3.2 42.8 8.8 57.4 27.2 3 3.7 5.5 7.6 8 11.5 1.7 2.5 3.3 5 5 7.3 14 19.7 40.7 23.2 52.3-.4C209 110 209 104.3 209 98Zm-44.4-35.8c5-2.3 8.1 0 11.4 2.9a42.6 42.6 0 0 1 18.5 31c.9 8.2 1 17.3-8.4 20.8-10.2 4-17.8-2.2-22-10.5A185.7 185.7 0 0 0 144.9 78l-4.6-6 7.3-2.9a281 281 0 0 0 17-7Z" fill="#000"/></g><g transform="translate(653 805)"></g><g transform="translate(901 668)"><path d="M82 57.5c4.9-6 9.2-11.2 13.8-16.2 2.5-2.8 6-4 9-1.2 3.5 3 1.3 5.8-.8 8.8C96 60.4 86 70.1 80.5 83.4c-4 9.8-5.3 19-2.3 29.6 5.8 19.9 10.5 40 15.1 60.2 3.3 14.4-2.3 23.8-16 29-4 1.6-7.9 3.2-11.7 5-16.4 8-30.4 1.5-44.4-8.6 3.8-8 9.6-10.7 18.5-5.7 8.7 5 32.7.6 39.6-6.8 4.5-5 1.4-9.7 0-14.4-5.8-19.7-14-38.7-15.6-59.8a68.6 68.6 0 0 1 18.4-54.4Z" fill="#000"/></g><g transform="translate(610 680)"><path d="M407.4 122.5c13 .3 25.4 1.1 37.6 2.5 3 .4 5 3.3 5 6.7 0 3.3-1.7 5.6-4.7 7-11.2 4.8-22 8.2-33.7.2-6.5-4.5-9-8.7-4.2-16.4ZM247.6 117c7 0 7.8 3.8 7 8.5-2 10.2-20 22.4-30.4 20.5-5.9-1-10.5-4-10.7-10.5-.2-6.7 4.8-8.2 10.3-8.4 9-.3 15.8-5.2 23.8-10ZM215.1 76.6c5-12 9-29.4 24.1-22.5 20.7 9.4 13.9 30.7 9.7 47.4-1.6 6.3-14.5 15.9-18.3 14.3-16.3-6.8-19.2-21.7-15.5-39.2ZM442 113.4c-8.6 7.5-17 7.6-22.2-1.5-9-16-8.6-32.8 3.3-47.2 2.5-3 13.8-3.6 16.3-1 14 15 14.6 31.8 2.6 49.7Z" fill="#000"/></g><g transform="translate(610 680)"></g><g transform="translate(774 657)"><path d="M30.3 32.1C58 10 89.8 13.1 121 14.1c5.7 0 12.2 1.3 14.3 8.3 2.1 7.7-4.6 9.9-8.8 13.8a44.7 44.7 0 0 1-52.2 8.6 37.9 37.9 0 0 0-31.9 1.6c-2 1-3.8 1.9-5.8 2.6-6.3 2.5-14.3 6-18.6-.4-4.4-6.7 5.6-9 8.3-13.7.6-1 2-1.6 3.9-2.8ZM294.4 23.8c7.7 4.3 14.5 10 20 17 2.5 3 5 6.3 3 10.2-2.4 4.3-6.7 2.7-10.4 2.2-12.5-1.5-23.7-9.2-37-7.2-5 .8-9.9.7-15 2.5-13 4.7-31-6.4-33-19.8-1-5.4 1-8.5 6.8-10 22.2-5.7 44-9 65.6 5.1Z" fill="#000"/></g><g transform="translate(0 559)"><path d="m14 1186.3 235.4 16.5s68.6-71.2 47.4-271.7c-3-29 27.8-209 29.3-222.7 4-36 21.3-104.9 40.1-131.2 85.3-119.3 74-138.5 79.3-166.4 5.7-29.4 15.4-80.4 21.3-100 2.7-9 22.5-72.8 4.8-75.8-84.4-14.2-65.4 148.2-97.5 133.2-49-23-59-87.3-59-87.3s-64.7-175.3-99-177.3c-14-.9 2.1 88.8 2.1 88.8s-72.3-95.6-89-95.7c-16.7 0 8 71.1 8 71.1s-34.8-30.2-48.7-20.8c-18.4 12.5 67 155.3 53.2 155.3-10.5 0-28.8-35.7-41.5-42.3-21.5-11.2-29.2-13.5-31.3 6.5-2.1 21.2 42.5 88.2 63 125.7 10.6 19.4 73.2 132 86.6 162.7 16.8 38.8-24.5 99.8-41.6 129.3-17 29.6-86.2 202.4-108.8 233.3-22.7 30.9-45.8 81.3-55.9 135.6-11.1 60.1 1.8 133.2 1.8 133.2Z" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="M339.5 676.2c-1.3 7.3-2.7 14.6-4.3 21.8l4.8-28.2a6441 6441 0 0 0-12.6 71c-1.7 10-3.2 20.1-4.7 30.2-5.7 40-9 80.4-12.3 120.7a72 72 0 0 1-3 13.7c-1.8 6.3-3.5 12.6-2.7 18.6 1.4 10.8 1.8 21.6 2.2 32.5.6 15.8 1.2 31.7 5 47.3a70 70 0 0 1 1.2 21.5c-2.6 41.7-9 82.4-24.5 121.6-8.2 20.8-18 40-34.2 56.2l-11.7-.6c3.8-10.5 9.6-19.8 15.5-29 4-6.5 8-12.9 11.4-19.7 9.3-19 15.8-39.1 19.2-60l.1-.8c3.3-19.3 6.7-38.7 7-58.5.2-12.4-.3-24.4-8-36l-9.8 27.5c-21.8 61.5-43.4 122.5-89.7 172.5a60 60 0 0 1-17-1c33-33.6 55.6-73.2 71.3-115.8l5.6-14.8c13.2-35.3 26.5-70.8 33.2-108.3 1.7-9.7 4-19.2 6.3-28.8 3.3-14 6.6-28 8.2-42.3l3.8-32.4c6.6-58 13.2-116 24.1-173.5a422.7 422.7 0 0 1 45.9-127.2c9.4-17 20-33.1 30.7-49.3 7.8-11.8 15.5-23.5 22.7-35.5l5-7.4c5.4-7.6 10.8-15.2 10.4-25.5-1.6-41.2 9-80.4 19.4-119.6l4.8-17.8c4.1-16 8-32.2 7.7-49-.1-10.2-5.5-14-13.7-9.2a114.9 114.9 0 0 0-45.8 57.3 209.2 209.2 0 0 0-12.5 61c-1.3 15.7-12.8 21.7-27.4 16.3-17.6-6.4-27.6-20.8-37.5-35l-.8-1c-9.3-13.4-14.5-28.6-19.7-43.8-2-6-4-12-6.4-17.8-17-43.3-35.4-86-56.6-127.5l-1.5-2.8c-7-14-14.6-28.8-31.8-36.2l2 18c4.6 42.6 9 84.4 22.8 124.8l-6.5 2.7c-24.8-57.6-53.8-112.2-101.5-155a26 26 0 0 0-2.6 18.5c3.7 23 13.8 43.4 23.9 63.8 3.6 7.2 7.2 14.5 10.5 21.8 4.5 10 9.8 19.8 15 29.5 3.5 6.4 6.9 12.7 10.1 19l.3.6c2.4 4.8 5 10.1.7 15.3-4.3-.7-5.6-3.3-6.8-5.7l-.3-.5a467 467 0 0 0-35-59.4c-11.7-17.5-23.4-35.1-39.8-49l-1.9-1.6c-4.4-4-9-8-14.4-3.7-6.3 5-4.8 13.3-1.6 20 4.6 9.6 9.4 19 14.1 28.5 6.2 12.5 12.5 25 18.4 37.7l7 15c10 21.4 20 42.8 29.5 64.4 1.9 4.4 3.2 9-3.7 13.3-11.6-9-20.8-20.5-30-32-12.6-15.7-25.3-31.4-44-41-6.6 8.2-8.6 15.5-2.3 26 9.6 16 18.6 32.5 27.6 48.8 6 11 12 22 18.2 33 5.6 9.8 10.5 20 15.3 30.3 6.6 13.9 13.1 27.8 21.6 40.6A683 683 0 0 1 216.9 536c13.8 31.2 9 61-2.7 90a915.5 915.5 0 0 1-50.6 100.5 597.7 597.7 0 0 0-35 79.5l-4.3 11.4-1.6 4.2c-9.7 25-19.4 50-27.2 75.7l-5.7 18.4c-6.9 21.8-13.7 43.6-17.9 66a426 426 0 0 0-5.8 100.3l.6 13.1c1.6 34.1 3.1 68 21.5 98.3l-34.6-2c-41.8-86.5-20.3-170.4 11.8-253.8a104 104 0 0 0-24.8 43.8c-7 21.9-13.3 43.9-17.8 66.4a342 342 0 0 0-2 137c.4 1 .9 2.2.8 3.8-4 .6-8 .4-11.8-.7l-.6-1.3c-3.1-7.4-6-14-6.6-21.4-2.2-25.4-3.5-51-2-76.3 2.4-38.4 13.7-75 25.2-111.5.8-2.2 1.4-4.5 2-6.8 1.4-5.5 2.8-11 5.8-16 12.7-21.3 25-42.8 37.3-64.4 7.6-13.3 15.2-26.6 23-39.8 13.7-23.7 24-49.1 34.2-74.6a703 703 0 0 1 27.3-62c6.4-12.4 12.3-25.1 18.1-37.8a656.8 656.8 0 0 1 24.7-49.9c14.1-24.8 18.5-49.6 10.6-76.5-7-23.7-19.5-44.7-32-65.7-4.1-7-8.3-14-12.3-21.1-4.5-8-9.3-16-14-23.8-8-13.1-16-26.2-22.6-40.1-10.4-22-22.2-43.2-34-64.4l-18.3-33-.7-1.5c-6.4-11.8-12.9-24-10.5-38.2 3-18 13.5-22.4 29.4-13.7 6.6 3.6 12.3 8.5 18 13.4 4.3 3.7 8.5 7.3 13.2 10.5-4.1-4.9-6-10.7-8-16.4a71.9 71.9 0 0 0-4-10.5c-12-23.7-23.3-48-33.7-72.5a26.6 26.6 0 0 1 6.5-30.7c7.6-6.7 17.3-5 25.7 1.3 2.3 1.7 5 2.9 7.8 4l3.6 1.7a56.7 56.7 0 0 1-6.6-36.5l.2-1.9c.6-6.8 1.1-13.6 8.4-16.6 8-3.2 15.6-1.8 22.5 4.2 16.2 13.8 29 30.3 42 46.9l1.6 2c3 3.6 5.5 7.5 8 11.4 4.6 6.7 9.1 13.4 15.2 19.3a310.8 310.8 0 0 1-9-60.3l-.4-3.3c-.7-5.8-1.4-11.2 5-14.8 7-4 13.3-.6 19 3.4 16.5 11.5 26.7 28 35.6 45.5a940 940 0 0 1 36.2 82.4c3 7.7 6.3 15.4 9.6 23a488.4 488.4 0 0 1 19.6 51.4 108 108 0 0 0 37.9 55c9.5 7.3 17.6 4.2 19.4-6.6l1.5-9.1c3.9-23.5 7.7-46.7 19.7-68.7 10-18.2 21.1-33.3 38.4-43.9 15.4-9.3 31-5.5 34.6 8.3a56 56 0 0 1 2 20.2c-2.5 22-8.5 43-14.5 64.2-3.1 11-6.3 22.1-9 33.3l-3.3 12.9a110.6 110.6 0 0 0-5.9 42c1.5 11.8.8 23.9-2 35.5-5.3 20.5-16.7 37.7-28 55-6.8 10.2-13.7 20.6-19.2 31.6-7.3 14.8-16.2 29-25 43.1-3.9 6.3-7.8 12.5-11.5 18.8-15.1 25.1-20.2 52.4-25.4 79.7ZM47.3 1056c0 .9-.1 1.7-.3 2.4-4 30.7 1.2 58.5 7 86.4-4-20.7-3.8-41.5-3.6-62.4 0-10.8.1-21.6-.3-32.4-2.6 1.5-2.7 3.8-2.8 6Z" fill="#000"/><path d="M273.6 406.4c1.5 24.2 6 46.1 19 66.5 6.3-5.2 5.6-9.6 4.2-13.5-13.4-37.4-9.8-76.3-10.2-114.9 0-2 0-4.2.2-6.4.2-4 0-7.9-5.5-8.1-5.4-.2-6.3 4.2-6.5 7.8-1 14.4-2.2 29-1.4 43.3.4 8 .5 16.1.2 25.3ZM246 540.3c-4.7-3-9-4.8-11.7.1-2 3.4 1.3 5.8 3.5 8.5a92 92 0 0 0 26.7 24.6c8.1 4.7 16 4.5 24.3 1.2 3-1.2 4.7-3.5 4.5-6.9-.4-4-3.4-4.3-6.5-4.4-17.3-.6-29.4-10.2-40.9-23.1ZM228 397c-5.5-2.2-10.3-3.5-14.8.3 5.8 10.8 28.6 23.9 39.5 22.5-2.5-13.5-15.4-15.6-24.6-22.8Z" fill="#000"/><path d="m1722 1194-240.1 4.4s-20.1-26.7-36.5-144.5c-4-28.4 12.9-82.2 10-162.5-4.2-124-27.7-283.6-31.8-294.3a1230.2 1230.2 0 0 0-75-150.5c-28.6-45.6-38.6-124.5-25.4-189.5 1.3-6.6 6-25.5 21.5-29.9 16-4.5 31.5 11.7 39.4 9 8-2.6 23.3-18.4 34.6-22.9s23.1-6 19.2-35.7c-1.8-13.7-34-163.7 1.5-168.4 31.5-4.2 40.8 78.1 48.5 108.6 10.8 43.5 13.5 95.5 18 103s35 26.3 48.1 50.8c13.2 24.4 13.2 54.2 9 81.9-6.7 43.7-41.9 134.8-19.4 205.1 13.8 43.4 120.8 304.8 142 357.7 20.5 51.7 51.8 143.4 51.8 173.3 0 58.4-15.4 104.5-15.4 104.5Z" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="M1649.7 1194c20.2-29.3 23.7-63.4 27.2-97.6l1.5-13.5c3.6-31.7 3.7-63.7.4-95.4a493 493 0 0 0-13.6-67.5l-5.4-22c-4-17.3-9.3-34.2-14.5-51-3.2-10.2-6.4-20.4-9.3-30.6a693 693 0 0 0-33.2-90.6c-4.4-10-9.1-20-13.9-30a509.4 509.4 0 0 1-30.6-74.8c-3-10.2-6.5-20.4-10-30.5-9-26.4-18-52.8-18.5-81-.4-30.1 6.5-59.4 13.4-88.6l.8-3.2c8-33.8 16-67.6 14.3-102.9-1.5-33.9-21-56.1-46.3-74.5-16.7-12.2-36.6-18-56.5-22a70 70 0 0 0-55.4 13.6c-9.1 6.5-9.4 18.2-1.7 30 17.7-23.3 41.1-19.2 63.9-15.2l7.7 1.3c5.3.8 10.6 2.4 16 4a126 126 0 0 0 17.2 4.2c7.8 1.2 11.8 5.4 15.8 13.6-14.5 3.5-27.4.1-40-3.1l-5.2-1.4-4.3-1c-13-3.4-25.6-6.6-39.5-4-17.3 3.3-27.5 12.2-28.7 29.9-.8 13.6-.4 27.3 0 40.9.2 6 2 12.9 9.7 12.5 6-.2 6-4.8 6.2-9.2v-2.7c2.4-28.6 34.4-55 62.6-50.6 3.2.5 6.5.8 9.8 1.2 11 1.2 22.1 2.3 31.8 9.1l2 1.3c2.7 1.6 5.4 3.2 3.8 7-2 4.9-6 3.7-10.3 2.4l-.6-.1-2.4-.7c-16.2-4.8-32.4-9.6-49.8-3.8a45.4 45.4 0 0 0-31 38.5 37.6 37.6 0 0 0 14.9 34.9c13.3 10.3 20.7 7.7 26.2-8 .8-2.3.6-5 .5-7.7-.3-5.1-.5-10.2 6-12.8 4.8-1.9 8.5.5 12.2 3a21 21 0 0 0 7.7 3.5 27.7 27.7 0 0 1 16.9 11.2c-5.7 6.7-11.2 4.7-16.7 2.8a27 27 0 0 0-7.3-1.8c-3 1.8-4 4.9-5 8-.3 1.2-.7 2.5-1.3 3.7-13 28.2-32 23.8-50.7 8.1h-.1c-2-1.7-4-3.4-5-5.6-5.4-13.2-13.5-20.1-29.4-18.6-7 .6-12-8.2-13-16.7a308.4 308.4 0 0 1-3-45.4c-5-.7-10-.7-15-.8-9.6 0-19.2 0-27.9-5-2.1-1.2-4-3.1-4.4-7.6 7.4-4.9 15.9-4.5 24.5-4 8.7.4 17.6.8 25.7-4-1-2-2.2-3.9-3.4-5.7-4.2-6.8-8.4-13.5-6.7-22.2.7-3.5-2.8-4.6-5.9-5.4a88 88 0 0 1-12-4.5c-14.7-6.3-26-.9-28.6 15-7.2 44-9 88.1-.2 132 3.5 17.5 10.3 34 20 49a465 465 0 0 1 29.6 55.4l9.7 20c7.2 14.5 13.2 29.5 19.2 44.4l10 24.6c16.2 37.5 21.7 77.4 26.7 117.5a1415 1415 0 0 1 10.2 131.4l1 26.3c1.2 23.8 4.7 47.2 8.1 70.6a1859 1859 0 0 1 4 28c5 37.4 16 73.3 26.9 109.1l4.5 14.8a320.6 320.6 0 0 0 64.2 119.8c-5.5.8-11.2.8-16.8 0-49.5-61.6-68-134.2-86.4-205.5l-3-11.9-.3 1-.2.5c-1.8 4.8-4 10.8-5.1 17.7-5 29-2.2 57.7.7 86.4a217 217 0 0 0 15.8 62.3c3 7.2 6.7 14 10.4 20.7 5.2 9.5 10.4 19 13.6 29.6H1483a161.4 161.4 0 0 1-30.8-58.1c-12-35.5-15.7-72-17-108.8-.4-11.2 2.5-22 5.4-32.6a129.9 129.9 0 0 0 6-39.9c1.4-22.8 2.7-45.4-.2-68.5a499 499 0 0 1-2.8-58.8c-.2-10.2-.2-20.4-.7-30.6v-1.1c-1-23.9-2-51.4-5-76l-2.2-21.5c-3.1-32.4-5.6-58-25.5-114.1-6.3-17.7-15-34.4-23.5-51-7.3-14.1-14.6-28.2-20.5-43a252.5 252.5 0 0 0-28.5-51c-15.9-22.6-19.8-48.4-23.7-74.3-.6-4.2-1.2-8.5-2-12.7-4.2-26.2-.8-51.9 2.6-77.5 1.2-9.7 2.5-19.4 3.4-29.1 2-21.4 22.8-30.8 49.1-24 4.2 1.1 8.2 2.6 12.4 4l6 2.2a56 56 0 0 1 29.5-21.3c14.3-3.8 14-12.7 13.7-24v-1c-.7-21.5-3.3-42.8-6-64.1-3.4-28.5-7-57-5.7-85.9 1-20.4 13.6-33.3 31.6-31 13.1 1.5 18.4 12.1 23.1 21.7 9.5 19.2 12.9 40.1 16.3 61 1.4 8.5 2.7 16.9 4.5 25.2 2.6 12.3 4.4 24.7 6.2 37.2 2.6 18.2 5.2 36.4 10.5 54.1l.2 1c.8 2.6 1.6 5.2 1.5 7.7-.5 9.7 4.4 15.3 12 20.7 26.4 18.5 44.4 44 50.4 75.3 4 20.7-.5 41.7-4.9 62.5l-1.9 9c-2.8 14-6 28-9.3 41.8a660.6 660.6 0 0 0-16.2 85.5c-1.9 18.9 3.1 36.6 9 53.5l1.4 4.2c8.2 23.4 16.3 46.8 26 69.7 21.1 49 40.8 98.5 59.7 148.3 3.2 8.4 6 17.1 8.6 25.8 5 16 10.1 32.2 18.3 46.8 11.8 21 22.3 42.7 32.8 64.4 7 14.4 14 28.9 21.3 43.1 2.7 5.2 3.8 10.8 5 16.3l1.4 7c9.4 37 18.5 74.2 18.6 112.7 0 25.4-2.8 50.8-6.5 76-1 7.4-4.2 13.8-7.8 21l-.7 1.3c-3.9.9-7.9.8-11.8 0l1.6-6.5c4.3-16.8 8.4-33.1 9-50.1 1.2-38.3.4-76.6-8.1-114.1l-1.6-6.9c-6.5-29.1-13.1-58.4-31.2-84 2 16.9 6.8 32.8 11.6 48.6 3.3 10.8 6.5 21.5 8.9 32.5 9.4 43.9 9.5 87.3-1.6 131-3.3 13.3-9 25.4-14.7 37.5l-6 12.8h-34.6ZM1440.9 142.3c2.7 19.6 5.5 39.4 3.5 60a85.2 85.2 0 0 1 36 6.3c5.7 1.9 11.4 3.8 17.2 5 2.5-4.3.7-7.5-1.2-10.7-1-2-2.2-4-2.3-6.2-2.5-37.3-10.6-73.6-18.7-109.9l-5.3-24c-3.3-14.6-9-28.5-17-41.1-2.3-3.8-5-6.8-10-6.6-5.4.3-6.9 4.7-8.2 8.6a76.3 76.3 0 0 0-2.1 35.4l1.3 8.8c1.7 10.6 3.4 21.6 2.8 34.2.3 13.5 2.1 26.8 4 40.2ZM1685.5 1148l4.5-22c4.1-29 4.9-56.2 5.7-83.6v-1.5c7.7 37 1 72.2-10.2 107Z" fill="#000"/><path d="M1523.3 552.2c-6.5 13.3-23.7 19-35.7 13.1-3.3-1.6-6-3.4-5.7-7.4.5-4.9 4.3-4.8 7.6-4.3 11.2 1.5 21.7-8.5 33.8-1.4Z" fill="#000"/></g></g></svg></div>
             <div class="agent-details">
                <div class="agent-role">Architect</div>
                <div class="agent-name">System Design & Planning</div>
             </div>
             <div class="thinking-dots"><span></span><span></span><span></span></div>
          </div>

          <!-- NOVA -->
          <div class="agent-card" id="agent-researcher" data-agent-key="researcher" draggable="true" style="--agent-color: #22c55e">
             <div class="agent-avatar" id="av_nova"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1744 1744" fill="none" shape-rendering="auto"><metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:RDF><rdf:Description><dc:title>Notionists</dc:title><dc:creator>Zoish</dc:creator><dc:source xsi:type="dcterms:URI">https://heyzoish.gumroad.com/l/notionists</dc:source><dcterms:license xsi:type="dcterms:URI">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>Remix of „Notionists” (https://heyzoish.gumroad.com/l/notionists) by „Zoish”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id="viewboxMask"><rect width="1744" height="1744" rx="0" ry="0" x="0" y="0" fill="#fff" /></mask><g mask="url(#viewboxMask)"><g transform="translate(531 487)"><path d="M554 727.7c-99.2 297-363.8 388.6-503.7 19.8-19.3-50.7 31-69.5 66.2-91.9 24.1-15.3 36.8-28.5 35.3-42.2-7-64.4-36.9-243.8-36.9-243.8l-3-5.8s.7-1.6-2.2 1.2c-3 3-9.9 34.2-37 34.2-24.5 0-49.2-10.9-61-86.3C7.2 285.6 9.6 214 40 201c12.5-5.3 24-7.2 35.2-.8 11.3 6.4-13-22 112-126C268.4 6.4 396.7-3.5 448.5 8 500.3 19.5 552 44.8 574.9 98.5c27.8 65-25.9 114.3-14 262.5-2.2 53.6.8 171.2-146.6 210.6-28 7.5-19.3 48.4 22.7 58.4 67 21 117 72.3 117 97.9" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="m554 266.2.1-1.4c4.1-36.4 8.2-71.7 27.1-103.4 6.5 4.4 5.7 10 3.7 15.2-19.9 51.2-18 104.4-16.2 157.6l.4 14c2.1 66.4-14.5 126.8-58.7 177.5-15.4 17.6-35.8 29.8-56.5 40.3-21.4 11-25.9 20.1-19.2 43.6l.8 2.6c1.4 3.9 2.8 7.9-1 11.8-4.5 4.6-9.5 3.3-14.8 1.8l-.6-.1a406.4 406.4 0 0 1-137-68.3c-6-4.4-10.8-10.3-15.5-16.1l-.3-.4c-2.5-3-3-7.8.5-10.4 3.3-2.5 5.8-.5 8.7 1.8l1 .9a145.5 145.5 0 0 0 76.3 31.7c13.4 1.4 26.6.9 40 .4 7.4-.3 14.8-.6 22.3-.5 10.2 0 18.7-4.7 26.7-9.2l2.8-1.6c27.8-15.5 54.3-32.8 72.2-60.7 16.1-25 25.9-52.2 31.6-80.9 7.2-36.1 6.6-72.7 6-109.8-.3-12-.5-24.2-.5-36.4ZM50.6 190.8c21.9-1.7 34 11.2 44.3 26.3a140.4 140.4 0 0 1 22.4 61.5c.5 3.7 1 7.6-1.2 11.3-4.5.6-4.9-3-5-5.6-.5-20.7-9.7-38.7-18.9-56.1-6.6-12.5-16.2-24.6-31.4-27.6-17.2-3.5-33 12-40.8 32.2-14.5 37.6-12 74.6 1.4 111 5.8 15.9 13.1 32.1 27.8 43.2 14.8 11.3 32.7 9.3 43.6-5.7l2-2.5c2-2.6 4-5.1 5-8 2.1-5.8 5.4-11.2 11.3-10.4 6.8 1 8 8.3 8.7 14a3661 3661 0 0 0 22 156.7l5.9 38.8c2.6 17.1 5.6 41.7 3.6 52.1a28 28 0 0 0-.3 2.2c-.4 2.8-.6 5-4.2 5.5-4.9.8-7-2-7.7-6.4-2.3-17-3-23.6-4-49.6-.9-25.2-5.6-50-10.4-74.9l-5-27c-5.2-30.8-10.3-62-10.8-97l-2 3c-7.6 11.3-13.7 20.5-24.5 24a40.5 40.5 0 0 1-46.1-12.5 127.8 127.8 0 0 1-28.8-55.8c-8.4-34-9.9-67.1.9-100.6 5.2-16.1 23.7-44.7 42.2-42Zm34.6 127.5c4.4 3.2 8.4 6 12-5.4-1.1-42.2-14.7-69.2-35.8-70.3 11.2 14.6 22 28.8 23 48.5a32.3 32.3 0 0 1-10.7-8.8c-2-2.2-4-4.4-6.5-6l-3-2.4c-4.8-3.6-9.7-7.4-17.8-4.5 3.8 5.8 9 10 14.3 14 6 4.7 12 9.3 15.6 16.5-10.6 7.7-15.2 17.7-9.7 29.9 4.8 10.5 11.9 19.2 25.9 19.8-.6-6.3-4.7-10.9-8.8-15.4-5-5.4-9.7-10.6-7.5-18.6 3.2-1.5 6.2.7 9 2.7Z" fill="#000"/></g><g transform="translate(178 1057)"><path d="M1301.3 694.3S1276 480.8 1263 423.6c-25.7-111.8-73.3-201.4-135.3-220.5-29.6-9.2-39.4-34-47-53.2-3-7.8-5.8-14.7-9.3-19.2C1040 90.7 975 50.5 941 37.3 914.5 27 838.5 20.6 813 30.7c-11.5 4.5-16.2 11-17.6 18.5-1.5.5-3 1.1-4.4 2-3.3 1.8-6 5-9.5 9C768 75.7 745 102.1 653.7 98c-72.5-3.2-120.5-13.8-149-58.3-2.3-3.6-5-4.8-8-4.2a223.7 223.7 0 0 0-163 19C316.2 64 219.4 158.4 218.4 163.7c-2 10.6-25.6 28-55.2 47.6C100.9 252.4 73.6 333 49.3 404.4l-6.6 19.2C31.8 455.2 6.1 692 6.1 692l176 2.3h1119.2Z" fill="#fff"/><mask id="bodyVariant07-a" style="mask-type:luminance" maskUnits="userSpaceOnUse" x="453" y="259" width="392" height="433"><path d="m467 692-14-432.5h392V692H467Z" fill="#fff"/></mask><g mask="url(#bodyVariant07-a)"><g transform="translate(396 278)" style="mix-blend-mode:difference"><path d="M204.9 175.7s150.1 43.7 172 42.1c9.5-.6 13.6-7 11.8-16.2a28 28 0 0 0-5.5-12c-2.9-4-186-225.6-203.5-184.5a16 16 0 0 0 .5 12.5c4.3 8 10.8 14.4 16.3 21.3 21.4 24.8 41.6 50.6 63.1 75.3 12.7 14.9 30.5 34.2 37.9 47.7-5.4-.5-15.1-3.5-21.1-4.9-13.5-3.4-27-7-40.5-10.3a313.1 313.1 0 0 0-60.2-9.7c-9.2-.1-20.4-.4-27 7.1-5.2 6.5-6 15.8-2.8 23.3 4 8.3 10.7 15 16.6 22a855 855 0 0 0 29.6 30.9c18.8 18.5 37.3 37.2 56.2 55.5 22 21 43.5 42.3 65 63.7 15.9 15.5 32 30.7 47.9 46.2 4.8 4.7 9.6 9.4 14.8 13.7l5.3 4.2c1.2.8 2.4 1.7 3.9 1.8 2.5-.4 3.3-3.5 3.6-5.7.9-5.8-2.8-10.7-5.6-15.3C358.6 345.7 205 175.7 205 175.7Z" fill="#fff"/></g></g><path d="M467.4 694.3S452.7 266.8 452.7 179c0-72.8 36.6-163 52-139.2 28.5 43.8 77.2 58.4 149.7 61.5 115 5 120.9-41.3 136.6-50 31.4-17.6 52.7 66 52.7 141.4V694" stroke="#000" stroke-width="15"/><path d="M1295 694c-6.2-21.3-11.5-73.3-14.9-102-2.4-20.7-19.6-166.5-38.5-217.4-11.6-31.1-22.4-63-39.5-92.1-11.7-20-29.3-34.3-46-48.9a513 513 0 0 0-67-48.2c-30.9-19.2-63.4-23-97.6-11.7a32 32 0 0 0-21.9 24.3c-13.4 53.3-9.1 107.6-9.8 161.6-.8 69.8 3.1 139.5 5.2 209.2 1.8 57.2 0 66.7-.6 125.2h-14.5c-.9-32.2-.4-15.3-.6-47.5-.2-47.6-.8-95.1-1.6-142.7-.6-37.8-.3-75.7-2.8-113.5-2.6-39.6-2.7-79.1.7-118.6 2.5-28.2.1-57 11.3-84.3 9.4-23 28.3-31.8 49.9-33.5 22.4-1.7 45.7-4.8 69.8 9.3-4.8-16.6-15-24.7-22.6-34-28-34.2-65.5-55.5-103.6-76.8-39.3-22-80.7-19-122.6-17.4-6.5.3-12 3.8-17.8 6.7-7.5 4-15.3 7.3-26.6 4.8 9.5-13 22.1-17.3 35.1-21.1 37.1-10.8 73-5.2 95.7-1.8C943 28 1042.7 76 1089.7 151.5c22.3 35.9 85.8 36.4 143.6 157.6a528 528 0 0 1 34.7 100.7c10.9 44 39.5 252.6 39.5 284.2H1295ZM15.3 694c2-6.9 2.7-9.9 3.6-15.7 4.6-28.4 5.5-57.6 8.9-86.3 2.4-20.7 3.3-41.4 6-62 7.2-52.7 15.6-105 32.5-155.4 10.7-31.7 22.4-63 39.5-92.1 11.7-20 29.3-34.3 46-48.9 20.7-18 43.5-33.7 67-48.2 30.9-19.2 63.4-23 97.6-11.7a32 32 0 0 1 21.9 24.3c13.4 53.3 9.1 107.6 9.8 161.6.8 69.8-3.1 139.5-5.2 209.2-1.8 57.2.5 125 .5 125l14.6.2c.9-32.2.4-15.3.6-47.5.2-47.6.8-95.1 1.6-142.7.6-37.8.3-75.7 2.8-113.5 2.6-39.6 2.7-79.1-.7-118.6-2.5-28.2-.1-57-11.3-84.3-9.4-23-28.3-31.8-50-33.5-22.3-1.7-45.6-4.8-69.7 9.3 4.8-16.6 15-24.7 22.6-34 28-34.2 65.5-55.5 103.5-76.8 39.4-22 80.8-19 122.7-17.4 6.5.3 12 3.8 17.8 6.7 7.5 4 2.3 11.5 6.4.7 5.8-15-2-13.2-15-17-37-10.8-74-4-111 .5-7.4 1-14.8 4.4-21.5 8-51.4 27.8-116 77.2-138.6 117.6-12 21.6-30.7 32.8-47.5 47.7C111 252.3 95.3 263.8 74.6 309a573.6 573.6 0 0 0-34.7 100.7c-11 44-19.1 88.6-22.8 134.2-2.7 32.4-7.4 64.8-10.3 97.4-2 22.8-3.5 39.7-3.5 52.6h12Z" fill="#000"/><path d="M1131.8 694c2-23.7-8-84.7-12.5-115.7-3.3-22.6-3-46-11.4-67.7-2.1-5.4-1.5-12.4 5.3-13.5 6.4-1 9.2 3.5 10.7 10.8 7.8 38.3 11.3 77.2 16 116 3.5 30 7.8 60 8.5 70l-16.6.1ZM193.3 694c1.4-23.6 8-84.7 12.6-115.7 3.3-22.6 3-46 11.4-67.7 2.1-5.4 1.5-12.4-5.3-13.5-6.4-1-9.3 3.5-10.7 10.8-7.8 38.3-11.3 77.2-16 116-3.6 30-5.7 70.1-5.7 70.1h13.7Z" fill="#000"/></g><g transform="translate(266 207)"><path d="M461.8 533c2.5-18.5-.2-36 .9-53.5 1-16 4.6-31.2 15-43.9 2-2 2.6-5 1.8-7.6-6.3-3.4-10 1.8-14 5-20.6 15.8-25 39.2-26.3 62.5-1.7 28.2-14.6 51.8-25.3 76.6-12.4 28.7-18.1 58.4-11.2 89.5a163.6 163.6 0 0 0 31.4 70.1c4.6 5.6 12.6 7.8 14.9 17.2-11.3 4.3-20.3-1.3-29-6.9a128.1 128.1 0 0 1-45-52.4c-14-28.4-25-57.8-22.2-90.6.9-9.9 3.7-19.2 6.6-28.4 8.2-26.3 1.5-50.7-10-74-7.2-14.6-32.4-14-41 .6-12.4 21.3-11 44.4-5.7 66.9 4.6 19.4 17 35.7 26 53.3 25 48.5 54 96.3 52.9 153.3a125.1 125.1 0 0 1-29 77.4 47.8 47.8 0 0 1-27.6 17.4c-9.4 2-18.6 3.3-24.3-6.8-31.2 15.7-55.7 20.3-61 4.2-15.5 5.5-31.7 6.2-47.7 7.4-5 .4-10.8.4-13-5.7-2.1-5.7 1.2-9.3 5.2-13.1 24.6-23.4 39.4-51 41-75.8a90 90 0 0 1-34.4 9c-6.9.2-13.6-2.3-18.6-7-3.8-3.4-4.7-7.2-1.6-12.4a341 341 0 0 0 20.4-36.5c6.7-14.6 7.2-29.8 7.2-44.8 0-18.8-4-37.3-11.7-54.4-12.3-27.5-11.2-56-4.8-84 5-22 10.2-44.5 24.3-63.7 29.5-40.1 64.3-70 118.2-65.5.8 0 1.5-.7 3.3-1.5-2.6-26 1.8-51.9 6.6-77.8a258 258 0 0 1 22.7-64.5c20-41.6 50.7-74.1 87.7-100.8a241.7 241.7 0 0 1 90.3-39.2c21.7-4.8 43.3-8 65.7-7.8 85.8.7 157 33.3 215.7 95.4 32 33.8 51 73.9 62 118.1 6.5 26 13.4 51.8 13.7 79 1.6 119.4-3.5 176-6.7 221.6-3.3 48.5-9.8 90.6-47.8 123-3.9 3.2-8.5 5.5-13 8-5.3 3.3-6.1-1-7-4.8-26.2 21.5-56.9 26.2-69.4 9.6 24.8-3.5 36.6-23 52.4-38.8 29-29 36.7-58.6 38.6-85.6 3.9-56.6-20-61.2-24-96.7-2-16.8 7.9-47.9 8.9-64.7 3.2-53.3-32.5-76.7-74-105.8-19.1-13.4-68.7-64-77.7-100-3.1-12.5-24 94.5-81.4 106.7-29 6.1-49.4 32.2-66.3 57.7-6.1 9.2-8.2 18.8-8.4 28.8-.3 15.4-1.3 30.7-6 45.4a75 75 0 0 1-20.8 30c-30.3 29.2-39.6 65.2-35 105.7a54.8 54.8 0 0 0 12.6 26.2c3.4 4.5 7.5 9.9 3 14.8-4.5 5-10.4 1-15.4-1-29.8-12-36.1-50-32.2-78.7 3.8-28 18.3-50.8 32.7-73.8 2.3-3.6 4.4-7.3 6.8-12Z" fill="#000"/></g><g transform="translate(791 871)"><path d="M197.7 98.9c-6-3.3-11.2-6-16.2-8.9a25 25 0 0 0-24-2 158.4 158.4 0 0 1-49 12.9c-12.6.8-25.3-8.2-25.7-18.7-.2-3-.8-6.2 3-7.4 2.8-1 5.2-.8 8 1.7 15.6 14.3 17.8 14.5 36.2 4.6 7.1-3.7 14-7.5 22-9.8 16.9-4.9 31.4-2 44.3 10 4.6 4.2 9.9 6.4 16.2 2.5 2.9-1.8 6.8-2.9 9.2.5 3 4.2-.7 7-3.4 9.7-5.5 5.6-11.2 10.7-20.6 4.9Z" fill="#000"/></g><g transform="translate(653 805)"></g><g transform="translate(901 668)"><path d="M99.8 182.6c-8.7 16.5-33.4 25.7-48.5 18.9-4.3-2-6.2-5.8-7-10-.5-2.7.9-5.3 3.3-6.5 4.6-2 5.8 2.3 8.6 4.8 7 6 13 .7 19-3.4 5.8-4 9.1-8.5 4.3-14.7-10.5-13.1-14.8-29.2-21.8-44-3.1-6.5-5-13.5-3.8-21 .5-3.3 1.9-5.5 5.6-5.6 2.8 0 5 .8 5.9 3.8 7.5 26.3 23.3 48.6 34.6 73.1.5 1 0 2.5-.2 4.6Z" fill="#000"/></g><g transform="translate(610 680)"><path d="M407.4 122.5c13 .3 25.4 1.1 37.6 2.5 3 .4 5 3.3 5 6.7 0 3.3-1.7 5.6-4.7 7-11.2 4.8-22 8.2-33.7.2-6.5-4.5-9-8.7-4.2-16.4ZM247.6 117c7 0 7.8 3.8 7 8.5-2 10.2-20 22.4-30.4 20.5-5.9-1-10.5-4-10.7-10.5-.2-6.7 4.8-8.2 10.3-8.4 9-.3 15.8-5.2 23.8-10ZM215.1 76.6c5-12 9-29.4 24.1-22.5 20.7 9.4 13.9 30.7 9.7 47.4-1.6 6.3-14.5 15.9-18.3 14.3-16.3-6.8-19.2-21.7-15.5-39.2ZM442 113.4c-8.6 7.5-17 7.6-22.2-1.5-9-16-8.6-32.8 3.3-47.2 2.5-3 13.8-3.6 16.3-1 14 15 14.6 31.8 2.6 49.7Z" fill="#000"/></g><g transform="translate(610 680)"></g><g transform="translate(774 657)"><g fill="#000"><path d="M102.1 42.8c-8.7-12.1-25.2-16-38.8-12.5-12 3.2-21.7 11-33.6 14.4-4 1.1-7.5 2.7-9.7-2.1-1.9-3.9-1.5-7.4 2.2-10.3C41 18 75.8 5.4 100.9 19.4a45.7 45.7 0 0 1 15 15c3.3 4.7 4.5 11.6 0 15.1-5.9 4.6-10-1.2-13.8-6.7ZM288 48.8c-9.7-6.5-18.9-7.3-28-.8-3.2 2.3-6.7 4.8-10 .8-3.3-4.1-2.4-8.6 1.3-12.6 5.6-6.1 13.2-7.1 20.8-8a33.7 33.7 0 0 1 36.7 30c.2 4.3 0 9.1-5.2 10.3-4.7 1-8.3-1.7-10.2-5.9-1.9-4.2-3.2-8.7-5.4-13.8ZM191.6 30c5.2-6.6 8-15 14.5-20.6 2.5-2.1 4.4-5.5 8.5-3.2 3.7 2.1 4 5.9 3 9-3.1 8.6-6.7 17.1-10.7 25.4-2 4-7 5.5-11 4.2-6.6-2-5-7.9-4.4-13.9v-1Z"/><path d="M191.7 29.8c-2 4.2-3.6 8.5-5.7 12.6-1.6 3.1-4.2 5.8-8 4.6-4.6-1.4-5-5.3-4-9.3 1.2-4.1 2.5-8 4-12 2-4.7 1.5-12.4 9.3-11.3 8.4 1.3 4.4 8.4 4.4 14.4v1Z"/></g></g><g transform="translate(0 559)"></g></g></svg></div>
             <div class="agent-details">
                <div class="agent-role">Researcher</div>
                <div class="agent-name">Knowledge & Discovery</div>
             </div>
             <div class="thinking-dots"><span></span><span></span><span></span></div>
          </div>

          <!-- BYTE -->
          <div class="agent-card" id="agent-coder" data-agent-key="coder" draggable="true" style="--agent-color: #3b82f6">
             <div class="agent-avatar" id="av_byte"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1744 1744" fill="none" shape-rendering="auto"><metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:RDF><rdf:Description><dc:title>Notionists</dc:title><dc:creator>Zoish</dc:creator><dc:source xsi:type="dcterms:URI">https://heyzoish.gumroad.com/l/notionists</dc:source><dcterms:license xsi:type="dcterms:URI">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>Remix of „Notionists” (https://heyzoish.gumroad.com/l/notionists) by „Zoish”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id="viewboxMask"><rect width="1744" height="1744" rx="0" ry="0" x="0" y="0" fill="#fff" /></mask><g mask="url(#viewboxMask)"><g transform="translate(531 487)"><path d="M554 727.7c-99.2 297-363.8 388.6-503.7 19.8-19.3-50.7 31-69.5 66.2-91.9 24.1-15.3 36.8-28.5 35.3-42.2-7-64.4-36.9-243.8-36.9-243.8l-3-5.8s.7-1.6-2.2 1.2c-3 3-9.9 34.2-37 34.2-24.5 0-49.2-10.9-61-86.3C7.2 285.6 9.6 214 40 201c12.5-5.3 24-7.2 35.2-.8 11.3 6.4-13-22 112-126C268.4 6.4 396.7-3.5 448.5 8 500.3 19.5 552 44.8 574.9 98.5c27.8 65-25.9 114.3-14 262.5-2.2 53.6.8 171.2-146.6 210.6-28 7.5-19.3 48.4 22.7 58.4 67 21 117 72.3 117 97.9" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="m554 266.2.1-1.4c4.1-36.4 8.2-71.7 27.1-103.4 6.5 4.4 5.7 10 3.7 15.2-19.9 51.2-18 104.4-16.2 157.6l.4 14c2.1 66.4-14.5 126.8-58.7 177.5-15.4 17.6-35.8 29.8-56.5 40.3-21.4 11-25.9 20.1-19.2 43.6l.8 2.6c1.4 3.9 2.8 7.9-1 11.8-4.5 4.6-9.5 3.3-14.8 1.8l-.6-.1a406.4 406.4 0 0 1-137-68.3c-6-4.4-10.8-10.3-15.5-16.1l-.3-.4c-2.5-3-3-7.8.5-10.4 3.3-2.5 5.8-.5 8.7 1.8l1 .9a145.5 145.5 0 0 0 76.3 31.7c13.4 1.4 26.6.9 40 .4 7.4-.3 14.8-.6 22.3-.5 10.2 0 18.7-4.7 26.7-9.2l2.8-1.6c27.8-15.5 54.3-32.8 72.2-60.7 16.1-25 25.9-52.2 31.6-80.9 7.2-36.1 6.6-72.7 6-109.8-.3-12-.5-24.2-.5-36.4ZM50.6 190.8c21.9-1.7 34 11.2 44.3 26.3a140.4 140.4 0 0 1 22.4 61.5c.5 3.7 1 7.6-1.2 11.3-4.5.6-4.9-3-5-5.6-.5-20.7-9.7-38.7-18.9-56.1-6.6-12.5-16.2-24.6-31.4-27.6-17.2-3.5-33 12-40.8 32.2-14.5 37.6-12 74.6 1.4 111 5.8 15.9 13.1 32.1 27.8 43.2 14.8 11.3 32.7 9.3 43.6-5.7l2-2.5c2-2.6 4-5.1 5-8 2.1-5.8 5.4-11.2 11.3-10.4 6.8 1 8 8.3 8.7 14a3661 3661 0 0 0 22 156.7l5.9 38.8c2.6 17.1 5.6 41.7 3.6 52.1a28 28 0 0 0-.3 2.2c-.4 2.8-.6 5-4.2 5.5-4.9.8-7-2-7.7-6.4-2.3-17-3-23.6-4-49.6-.9-25.2-5.6-50-10.4-74.9l-5-27c-5.2-30.8-10.3-62-10.8-97l-2 3c-7.6 11.3-13.7 20.5-24.5 24a40.5 40.5 0 0 1-46.1-12.5 127.8 127.8 0 0 1-28.8-55.8c-8.4-34-9.9-67.1.9-100.6 5.2-16.1 23.7-44.7 42.2-42Zm34.6 127.5c4.4 3.2 8.4 6 12-5.4-1.1-42.2-14.7-69.2-35.8-70.3 11.2 14.6 22 28.8 23 48.5a32.3 32.3 0 0 1-10.7-8.8c-2-2.2-4-4.4-6.5-6l-3-2.4c-4.8-3.6-9.7-7.4-17.8-4.5 3.8 5.8 9 10 14.3 14 6 4.7 12 9.3 15.6 16.5-10.6 7.7-15.2 17.7-9.7 29.9 4.8 10.5 11.9 19.2 25.9 19.8-.6-6.3-4.7-10.9-8.8-15.4-5-5.4-9.7-10.6-7.5-18.6 3.2-1.5 6.2.7 9 2.7Z" fill="#000"/></g><g transform="translate(178 1057)"><path d="M1301.3 694.3S1276 480.8 1263 423.6c-25.7-111.8-73.3-201.4-135.3-220.5-29.6-9.2-39.4-34-47-53.2-3-7.8-5.8-14.7-9.3-19.2C1040 90.7 975 50.5 941 37.3 914.5 27 838.5 20.6 813 30.7c-11.5 4.5-16.2 11-17.6 18.5-1.5.5-3 1.1-4.4 2-3.3 1.8-6 5-9.5 9C768 75.7 745 102.1 653.7 98c-72.5-3.2-120.5-13.8-149-58.3-2.3-3.6-5-4.8-8-4.2a223.7 223.7 0 0 0-163 19C316.2 64 219.4 158.4 218.4 163.7c-2 10.6-25.6 28-55.2 47.6C100.9 252.4 73.6 333 49.3 404.4l-6.6 19.2C31.8 455.2 6.1 692 6.1 692l176 2.3h1119.2Z" fill="#fff"/><mask id="bodyVariant07-a" style="mask-type:luminance" maskUnits="userSpaceOnUse" x="453" y="259" width="392" height="433"><path d="m467 692-14-432.5h392V692H467Z" fill="#fff"/></mask><g mask="url(#bodyVariant07-a)"><g transform="translate(396 278)" style="mix-blend-mode:difference"><g fill="#fff"><path d="m302.9 264.7-.5.1h.5Z"/><path d="M410.3 250c-3-10-7.3-19.7-13-28.5a217.4 217.4 0 0 0-24.8-32.8 410 410 0 0 0-64.7-54.4 371.2 371.2 0 0 0-53.1-30A199.3 199.3 0 0 0 188 83.5c-12-.9-24.3-.1-36.2 2.3 11 1 22 2.8 32.7 5.4 14.8 4 33.2 11.6 49.3 18.1 20.5 9 40.7 18.8 59.8 30.5 29.6 19 53.5 38 76.8 62.8 12.4 14.3 20.5 25 28.4 40.5 3.7 8 6.4 16.6 8 25.3.8 6.1.7 5 .8 8.6v1.4l-.4 2.8v.1a44.4 44.4 0 0 1-19.2 27.3c-26.3 17-53 25.7-84.3 24.3-20.5-.8-41.7-6-58.8-10.7a385.2 385.2 0 0 1-61.8-22.6c-17-8-33.5-17.2-48.2-29-16.7-13.3-31.1-24.6-45-42.6-9.2-11.8-14.4-19.2-19.9-33l-.8-2.5c-1.6-5.4-1-2.5-1.7-8.3.2-3.5-.8-8 2.4-13.3a63 63 0 0 1 33.3-24c7.4-2.3 21.7-4.6 32.5-4.7 8-.1 16 1.2 23.9 2.4 15.7 2.8 28.7 6.9 44.7 13.5 14.7 6 29 12.8 42.9 20.4 29.1 16.6 63 42.2 70.4 67.4l.4 1.6v.2c.3 1.2.5 2.5.6 3.7v.3a114.5 114.5 0 0 0-.2 1.7l-.3 1.3c-1.5 4-7 7.6-15.3 10.1h-.3l-.3.2h.1a86 86 0 0 1-16.3 1.6c-9.5.1-18.9-1.6-28-3.8a126.6 126.6 0 0 1-38.1-15.5 189 189 0 0 1-26.9-18.4c-5.9-5-11.6-10.3-16.3-16.6-2-3-2.9-4.1-3.9-7.7a39.8 39.8 0 0 1 .2-.8l.2-.3v-.2l1.2-1.3.3-.4.3-.2c2.8-1.9 5.9-3.3 9-4.3 4-1.1 8.2-1.7 12.3-1.7a100.8 100.8 0 0 1 45.5 11.7 103 103 0 0 0-11.2-8.6c-12.8-8.2-29.1-15.6-44.6-14.2-12.4 1.7-19.9 6.7-20.1 20-.2 12.2 8.1 22.3 16.5 30.3 6.3 6 13 11.6 20.3 16.6a213.5 213.5 0 0 0 34 19c7.7 3 15.6 5.5 23.7 7.2 9.6 2.2 19.5 3.6 29.3 3 6.7-.3 13.5-1.1 19.7-3.8 25-9.7 16.6-42 3.8-58.7a158.2 158.2 0 0 0-36.9-35.3 284 284 0 0 0-51.1-29.7c-14-6.3-28-12.5-42.8-16.8a209.3 209.3 0 0 0-39.5-7.7c-7.8-.4-15.6 0-23.2 1.1A76.8 76.8 0 0 0 77.2 147a49.5 49.5 0 0 0-13 15.9 49.1 49.1 0 0 0-3.4 24c1.6 18.5 11.9 35 22.9 49.6a187.5 187.5 0 0 0 30.9 32.4c11.3 9.5 22.6 19.1 35 27 25.6 16 53.7 27.7 82.4 36.6 28.4 8.3 57.8 16 87.6 14.2a144 144 0 0 0 75.9-29 55.6 55.6 0 0 0 19-35.6 90 90 0 0 0-4.2-32Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M528.4 299.2c2 3 4 6.1 4.8 9.6 1 4.7 1.3 11-3 14.2-2.5 1.4-5.6 1.7-8.5 2l-1.4.1c-5.3.4-10.6.5-15.9.4h-.4c-2.8 5.2-5.5 10.5-8 16 1.3-5.1 3-10.6 5-16.2a213 213 0 0 1-8-.5 142.3 142.3 0 0 0 3.3 8.2l-.5-.7-.6-1c-1.4-2.1-2.8-4.3-4-6.6a126.6 126.6 0 0 1-26-5c-5-1.5-10.6-3.3-12.2-8.7-1.3-5-.3-11 4.2-14a142 142 0 0 1 18.1-12.4c-.7-3-1.4-6.3-1.8-9.5-.7-7.3-1.7-22.4 9-22.2 4.4 1 7.9 4 11.2 6.8l1.6 1.3a150.9 150.9 0 0 1 8.8 8.5c3.8-1.7 7.7-3 11.6-4.2 3.1-.8 6.4-1.4 9.5-.4 3.8 2 4 7 3.5 10.8-.5 2.8-1.4 5.4-2.7 7.9l-3.5 7.1c2 2.6 3.8 5.3 5.6 8l.3.5Zm-8.8-20.8c-1.7.3-3.4.7-5 1.3l-.4.1-.5.2 3.6 4.2 2.4-5.8Zm-37.2-11.6 4 2c2.5 1.8 4.9 3.7 7 5.8a349 349 0 0 0-12.5 6.8 58.4 58.4 0 0 1-1-14.2l.8-.4h1.7Zm-3.3 30.2c-4.7 2.7-9.4 5.6-13.8 8.7 6 2 12.4 3.4 18.8 4.2a244.4 244.4 0 0 1-5-13Zm9 13.4-4.3-16v-.1l2.8-1.6c5.4-3 11-6 16.6-8.5a222 222 0 0 1 9.6 10.8l-6.6 16.5c-6 0-12.2-.4-18-1Zm29.3-9.7-5.8 10.8c4.3 0 8.6-.3 12.9-.8l-.9-1.4c-2-2.9-4-5.8-6.2-8.6Z"/><path d="M262.6 221.8c2 6.7 3.6 10.8-3.4 12.4-5.4 1.1-11 .5-16.4.4-.8 0-1.1 0-.2.3a45 45 0 0 0 9.6 3.6c12.6 3.2 17.6-6.8 10.4-16.7ZM412.8 353.9c-4.7 2.5-9.9 4.1-15 5.8a237 237 0 0 1-21.2 5.6 261 261 0 0 1-58.3 5c-22.6-1-45-4.8-66.8-11-18-5-45.7-11.8-72.3-22.3l-5.7-2.3a851 851 0 0 0 56.3 29.5 196.2 196.2 0 0 0 55.3 16.5c18.7 3.2 37.7 4.2 56.7 3 10.3-.6 20.8-1.6 30.9-4.3a134 134 0 0 0 39-17.4c8.7-6.3 15-15 21.4-23.6-6.6 5.7-12.6 11.2-20.3 15.5ZM391.5 147.3l-4.2-2.4 7.3 7a340.7 340.7 0 0 1 50.5 71.3c-8.6-31-23-61.4-53.6-76ZM18.6 152c5.3-8.4 19-25 29-31.4A100 100 0 0 1 75.5 106a95.2 95.2 0 0 1 21.2-2.5 69.2 69.2 0 0 0-23.6-2.9A78.2 78.2 0 0 0 44 111c-13.7 8-24 20.7-32 34.1a89.6 89.6 0 0 0-11 45c.8 19.6 8 38.5 18.3 55a300 300 0 0 0 38 44.2l15.1 14.5A518 518 0 0 1 27.1 242c-14.5-23.5-21.2-43.7-18.5-62.6a64 64 0 0 1 10-27.5Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M134.7 341.1c-1.8-3-3.7-6-5.8-8.9l-.6-.7-.5-.6 1.4-2.6c1.3-2.1 2.5-4.3 3.3-6.7.8-3.5.8-8.2-2.3-10.6a7 7 0 0 0-4.4 0 43.7 43.7 0 0 0-11.4 4.2A264.7 264.7 0 0 0 91.6 294c-1-.9-2.1-1.8-3.4-2.4-3.5-1.4-5 3.2-5.3 5.8a64.1 64.1 0 0 0 2.5 20.5c1 4.3 2.3 8.6 3.7 12.8l-4 2.8-.7.5-9.8 7c-3 2.3-6.4 4.9-7 8.9-.7 3.5-.5 8.3 2.9 10.4 3.6 1.2 7.5 1.5 11.4 1.8l2.4.2c5.3.4 10.6.4 16 .1 2.3 6.7 4.7 13.4 7.3 20 .2.9.7 1.7 1.3 2.4-.7-1.2-1-2.6-1.2-4l-.4-1.9-1.5-6.5-2.2-10.2c2 0 4.1-.2 6.2-.4-1.2 4.6-2.1 9.4-2.7 14.1 1.4-4.9 3.1-9.7 5.1-14.3a464.7 464.7 0 0 0 10.6-1.2l7.8-1c1.2-.2 2.4-.6 3.6-1a7 7 0 0 0 2.4-3c2-4.7.8-10-2-14.2Zm-44-32.9c4.8 4 9.3 8 13.6 12.4l-9.4 6c-1.7-6.7-3.2-13-4.2-18.4Zm2.5 34.4-8.4 5.7c3.5.2 7 .3 10.5.2l-2.1-6Zm7.3 5.8-2.3-9.2 4.7-3c3.1-2 6.8-4.2 10.5-6.2 1.6 1.8 3.4 3.7 5 5.7a230.1 230.1 0 0 0-4.3 11.6c-4.5.5-9 .9-13.6 1Zm19.8-3.5-1 1.9 7.2-1c-1-1.5-2.5-3.3-4-5.2l-.5 1-1.7 3.3ZM380.5 75.7c-1.2-2-3-3.5-5.2-4.4l-8-3.8c.3-14 .3-27.9-.3-41.8-.3-2-1.1-5.4-3.7-4.6a17.3 17.3 0 0 0-3.6 5 341 341 0 0 1-19.6 29.4 646.9 646.9 0 0 0-43.3-16.7c-1.8-.6-3.6-1.2-5.3-.4-4.3 3.3-3.8 10.2-1.7 14.6a64 64 0 0 0 9.8 12.5l.2.2c5.4 5.8 11.2 11.1 17 16.4l1.6 1.4 1 1a5872 5872 0 0 1-15 9.4 27 27 0 0 0-5.7 4 6 6 0 0 0 0 6.6 3 3 0 0 0 2.6.8c1.5 0 3-.3 4.6-.5 5.1-.9 10.2-2 15.3-3.1l5-1.2 9-2a3942 3942 0 0 0 12.6 11.1c4.2 3.7 10.2 9 14.2 5.6 3.4-3.3 3.8-8.2 4.1-12.7l.2-2.3.5-8.6 6.2-1.2c.5 0 1-.2 1.4-.3 1.4-.3 2.8-.6 4-1.3 4-2.9 4-9 2-13Zm-20-12.7v1.4l-9.3-4.1 5.6-6a57 57 0 0 0-8.4 4.8 242.4 242.4 0 0 1-4-1.7l-1.4-.6c6.5-6.2 12.5-12.8 18-19.8-.3 7.4-.4 16.6-.5 26Zm-55-7A1166.6 1166.6 0 0 0 337 85a225.8 225.8 0 0 1 23.2-6v-.5c-5.7-2.6-11.5-5-17.3-7.5l-3.5-1.5a55 55 0 0 1-5.6 3 94 94 0 0 1 3.5-3.9l-5-2.1a54 54 0 0 0-.7.6l.4-.5.1-.2c-8.8-3.6-17.6-7.2-26.6-10.5Zm5 38.4c3.3-3 6.5-6.2 9.6-9.4l4.5 4.1a556 556 0 0 0-14 5.3Zm38.5 1 1.8 1.7 1 .9c1.5 1.2 3.7 3.2 6.7 4.4h.5c.3-2.6.6-5.7.7-9.3L349 95.4Z"/></g></g></g><path d="M467.4 694.3S452.7 266.8 452.7 179c0-72.8 36.6-163 52-139.2 28.5 43.8 77.2 58.4 149.7 61.5 115 5 120.9-41.3 136.6-50 31.4-17.6 52.7 66 52.7 141.4V694" stroke="#000" stroke-width="15"/><path d="M1295 694c-6.2-21.3-11.5-73.3-14.9-102-2.4-20.7-19.6-166.5-38.5-217.4-11.6-31.1-22.4-63-39.5-92.1-11.7-20-29.3-34.3-46-48.9a513 513 0 0 0-67-48.2c-30.9-19.2-63.4-23-97.6-11.7a32 32 0 0 0-21.9 24.3c-13.4 53.3-9.1 107.6-9.8 161.6-.8 69.8 3.1 139.5 5.2 209.2 1.8 57.2 0 66.7-.6 125.2h-14.5c-.9-32.2-.4-15.3-.6-47.5-.2-47.6-.8-95.1-1.6-142.7-.6-37.8-.3-75.7-2.8-113.5-2.6-39.6-2.7-79.1.7-118.6 2.5-28.2.1-57 11.3-84.3 9.4-23 28.3-31.8 49.9-33.5 22.4-1.7 45.7-4.8 69.8 9.3-4.8-16.6-15-24.7-22.6-34-28-34.2-65.5-55.5-103.6-76.8-39.3-22-80.7-19-122.6-17.4-6.5.3-12 3.8-17.8 6.7-7.5 4-15.3 7.3-26.6 4.8 9.5-13 22.1-17.3 35.1-21.1 37.1-10.8 73-5.2 95.7-1.8C943 28 1042.7 76 1089.7 151.5c22.3 35.9 85.8 36.4 143.6 157.6a528 528 0 0 1 34.7 100.7c10.9 44 39.5 252.6 39.5 284.2H1295ZM15.3 694c2-6.9 2.7-9.9 3.6-15.7 4.6-28.4 5.5-57.6 8.9-86.3 2.4-20.7 3.3-41.4 6-62 7.2-52.7 15.6-105 32.5-155.4 10.7-31.7 22.4-63 39.5-92.1 11.7-20 29.3-34.3 46-48.9 20.7-18 43.5-33.7 67-48.2 30.9-19.2 63.4-23 97.6-11.7a32 32 0 0 1 21.9 24.3c13.4 53.3 9.1 107.6 9.8 161.6.8 69.8-3.1 139.5-5.2 209.2-1.8 57.2.5 125 .5 125l14.6.2c.9-32.2.4-15.3.6-47.5.2-47.6.8-95.1 1.6-142.7.6-37.8.3-75.7 2.8-113.5 2.6-39.6 2.7-79.1-.7-118.6-2.5-28.2-.1-57-11.3-84.3-9.4-23-28.3-31.8-50-33.5-22.3-1.7-45.6-4.8-69.7 9.3 4.8-16.6 15-24.7 22.6-34 28-34.2 65.5-55.5 103.5-76.8 39.4-22 80.8-19 122.7-17.4 6.5.3 12 3.8 17.8 6.7 7.5 4 2.3 11.5 6.4.7 5.8-15-2-13.2-15-17-37-10.8-74-4-111 .5-7.4 1-14.8 4.4-21.5 8-51.4 27.8-116 77.2-138.6 117.6-12 21.6-30.7 32.8-47.5 47.7C111 252.3 95.3 263.8 74.6 309a573.6 573.6 0 0 0-34.7 100.7c-11 44-19.1 88.6-22.8 134.2-2.7 32.4-7.4 64.8-10.3 97.4-2 22.8-3.5 39.7-3.5 52.6h12Z" fill="#000"/><path d="M1131.8 694c2-23.7-8-84.7-12.5-115.7-3.3-22.6-3-46-11.4-67.7-2.1-5.4-1.5-12.4 5.3-13.5 6.4-1 9.2 3.5 10.7 10.8 7.8 38.3 11.3 77.2 16 116 3.5 30 7.8 60 8.5 70l-16.6.1ZM193.3 694c1.4-23.6 8-84.7 12.6-115.7 3.3-22.6 3-46 11.4-67.7 2.1-5.4 1.5-12.4-5.3-13.5-6.4-1-9.3 3.5-10.7 10.8-7.8 38.3-11.3 77.2-16 116-3.6 30-5.7 70.1-5.7 70.1h13.7Z" fill="#000"/></g><g transform="translate(266 207)"><path d="M392.5 323.4c31.7 28.4 50.7 55.3 49.6 78.8-1 23.5-14.3 64.5-20.4 75.7-6.2 11.3-6.7 29.7-12.8 50.6-6.2 21-8.6 38.7-25.5 36.6-16.9-2-6.2-19.7-22-47.8-16-28.1-24.1-41.4-44.6-43-20.4-1.5-21.1-28.2-14.3-48 6.9-20.2 16.9-86 34.3-99.3 17.4-13.3 55.7-3.6 55.7-3.6Z" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="M493.2 369.5c-2.5 8.5-8.2 13.4-13.9 18.2l-3.2 2.8C461 404 453 421.8 445 439.7l-4.6 10c-11 23.5-18.9 48-26.5 72.6-1.3 4.3-2.1 8.7-3 13-1.5 8.6-3.1 17.2-8.4 24.6a6 6 0 0 0-.6 1.2c-.2.4-.3.7-.6 1l-1.5 2.5c-4.5 6.8-9.2 14-17.6 14.2-8 0-9.4-6.2-10.8-12.3-.5-2.2-1-4.3-1.7-6.1a91 91 0 0 1-5-19.2c-1.3-7.3-2.6-14.5-5.8-21.3-11.9-24.9-27.2-44-58.6-42.6-10 .5-9.2-9.3-7.8-15.4 1.9-7.8 3.3-15.7 4.7-23.7 2-10.8 4-21.7 7-32.3 2.6-8.6 4.9-17.3 7.2-26 4.6-17.5 9.2-35 15.9-52a210.6 210.6 0 0 1 58.2-82.2c32-28.3 67.7-50.8 105.5-70.6 45.5-23.8 94-38.2 143.9-49.5 41.7-9.5 83.6-9.1 125.2-.4 28.3 6 56 15.5 75.4 38.7 29.1 35.2 43.1 74.4 28.2 120.6a168.7 168.7 0 0 1-18.3 40.2c-20.5 32-52.6 39.1-87.3 40.2-31.7 1-63-3.5-93.3-12a189 189 0 0 0-114 2.7 124.7 124.7 0 0 1-44.3 4c-6.9-.2-11.6 1.6-13.2 10ZM373.9 506.7c-5.3 10.9-2.3 20.7.8 30.5a63.1 63.1 0 0 1 3.8 17.9c5-8 11.8-10.5 19.4-10.3l1.5-6.2 3-12 2.2-6.6c2.8-8.2 5.6-16.3.8-26-3.1-6.3 1.8-14.5 8-18.7 8.5-5.7 11.7-13.5 13.7-24.7-8 11-8 11-16 12.3-4.2-19 0-24.5 19.6-25.6 9.2-20.8 3.3-46.5-15.3-65l-2.5 3.8c-2 3-4 6-6.2 8.7-2.6 3.2-6.7 5-10.2 2.8-3.7-2.2-2.3-5.6-1-9l.5-1.2a33.1 33.1 0 0 1 13.7-14.8c-6.6-12-15-21.6-26-28.2-18.6-11.2-41-2.5-46.5 17.6-1.2 4.4-2.6 8-6.4 10.4-8.8 5.7-10.7 14.7-12.3 27l.8-1.3c3.4-5.3 5.8-9 10.7-7.8 2.6.6 4.6 3.6 3.6 6-.8 2.2-1.4 4.6-2 7-1.3 5.8-2.7 11.6-8.6 15.1-.6.4-1.6.3-2.3.2l-.6-.1c-2.3-1-2.5-2.9-2.8-4.8-.2-1.6-.5-3.3-2-4.6a51.6 51.6 0 0 0-1 14.8c.2 9.7.4 19.1-9.5 26.3l2.3-.7c5-1.6 9.7-3 11 3.1 2.1 10.4-3.8 17.1-15 20.3a46.5 46.5 0 0 0 26.5 8.3c1-1.6 1.8-3.2 2.6-4.8l.7-2.4c1.3-4.2 2.6-8.6 8.8-6 5.7 2.4 3.2 7.2 1.3 10.9l-.5 1c-2.5 5-2 8.5 2 12.3a228.6 228.6 0 0 1 14.8 15.3c1.6-.7 3-2 4.3-3.2 2.5-2.3 4.7-4.4 8.4-2.3 4 2.3 3.4 6.2 2.5 10.9a65 65 0 0 0-.6 3.8Zm458-194.8c16.6-25.3 19.3-54.1 21.7-83l-2.6-15-.2-1.2a96 96 0 0 1-18.9 99.2Z" fill="#000"/><path d="M830.1 484.3c-1.1-21 5.3-40.3 7.6-60.1 2.6-22.2 1.6-44.2 1-66.3-.1-4.6 0-9.1.5-13.7.7-6.7 3.2-12.5 10-13 6.2-.3 8.6 5.6 10.3 11.2 6.5 21 8.5 41.8 3.4 64a474 474 0 0 1-22.3 67.4c-1.7 4.5-2.9 11-10.5 10.5ZM352.8 342c13 3.2 4.6 11.2 4 16.9-.7 6.7-5.4 12-12.4 12.4-5.4.3-7.2-4.4-5-9 3.4-7.1 5.3-15.2 13.4-20.4ZM410 427.9c-6.1-7.6-3.8-22.2 3.2-26.6 2.3-1.5 4.7-2 7.2-.4 2.3 1.5 3.7 4 3 6.5-2 8.1-2.8 17-13.4 20.5ZM395.9 459.7c7.5 11.8-1.8 18.6-7 26.2-1.8 2.8-6.2 2-7.8-2.5-3-8.4 4.4-21.3 14.8-23.7ZM364.4 384.6c-2.3 6-4.8 10.9-6.7 16-1.8 4.5-4.9 5.8-9 4.2-4-1.7-3.4-5.5-2.7-8.8 1.2-6 4.6-10.9 8.6-15.2 4.7-4.9 8-3.4 9.8 3.8ZM389.8 353.9c-4.1 9-4.5 20-17 23.6-3-11.6.7-19.9 8-27 4-4 6.7-1.4 9 3.4ZM372.3 460.6c-1.4 3.6-2.2 6.7-4.1 8.7-2.6 2.9-3.6 9-9.2 6.9-5.2-2-3.7-7.4-3-11.2 1-6.6 4.9-12.3 11.2-13.7 5-1.1 5.1 4.3 5 9.3ZM349.7 429.7c1.3-2.8 1.8-5 3.2-6.5 2.9-3 3-10.9 9.3-7.7 6.4 3.2 3.5 10 1.7 14.7-1.8 4.8-5 10.8-11.3 10.3-6-.5-4.6-5.7-2.9-10.8ZM392.9 420.6c.4 7.4.6 13.8-3.8 19.2-2 2.4-4.5 3.8-7.8 2.5-3.7-1.5-3.6-4.4-2.7-7.4 1.2-4.1 1.9-8.4 3.7-12.2 2-4.3 5-8.5 10.6-2.1ZM385.7 513.1c4.2-4 4.7-13.9 11.6-9.9 7.7 4.4 1.6 11-1.3 16.5-1.8 3.6-4 7.5-8.4 6-6.4-2.3-4-7.4-1.9-12.6ZM323.8 440.5c-2-3-2-5.4-.5-7.7 2.5-4 2.4-11.1 9.3-10 5.9.9 4.4 6.7 3.7 10.3-1.1 6-3.7 11.6-12.5 7.4ZM384.7 393.4c.8 1.6 1.3 2.4 1.2 3.2-.6 4.6-.7 9.8-6.7 10.7-3.7.6-5.7-2-5.4-5.4.5-6 2.6-11 11-8.5Z" fill="#000"/></g><g transform="translate(791 871)"><path d="M130.4 84.6a46.5 46.5 0 0 1 28.5-7.8c6.2.5 10.7 3.5 11 9.9.3 7.4-5.7 7-10.8 7.1h-24c-5.5-.3-7.8-3-4.7-9.2Z" fill="#000"/></g><g transform="translate(653 805)"><path d="M228.4 117.6c-21.6 3.1-40.3-2.1-61.6 3.7-4.3 1.2-9 0-11-2.7-2.3-3.4 3.5-5.5 6.2-7.8 16.7-14.3 34.5-27.4 59.2-26 10.4.6 20 3 30.7 3.1 3.6 0 7.4-.4 10.6.3 5.2 1.2 14.6-1 13.5 6.2-1 6.3-7.4 11-15 13-10.8 2.8-21 7.1-32.6 10.2ZM351.6 115.6c21.6 3.1 40.3-2.1 61.6 3.7 4.3 1.2 9 0 11-2.7 2.3-3.4-3.5-5.5-6.2-7.8-16.7-14.3-34.5-27.4-59.2-26-10.4.6-20 3-30.7 3.1-3.6 0-7.4-.4-10.6.3-5.2 1.2-14.6-1-13.5 6.2 1 6.3 7.4 11 15 13 10.8 2.8 21 7.1 32.6 10.2Z" fill="#000"/></g><g transform="translate(901 668)"><path d="M65.7 43.5c-4.3 23.6-7.3 45.8-.3 68.8A79.4 79.4 0 0 0 98 157.1c22.3 14.8 22.7 43 .4 57.5-24.6 16.2-50.8 14-77 7.5-11.8-3-17.9-14.2-21-25.4-2.7-9.6 6.5-25.2 16.6-31 3.1 3.8 2.4 7 .2 11.3-6.7 12.3 0 31.4 13.5 32.6 19.8 1.7 40.7 5.8 59.1-8 12.5-9.4 14-21.5 1.8-31.4-7.3-5.9-14.4-11.7-20.6-18.8-28-31.7-29.9-68.2-20-107 3.5-14.3 9.2-27 19-38C73 3 76-.9 80.5 2c5.9 3.9 1.2 8.4-1 12-5.6 9-10.6 18.3-13.8 29.5Z" fill="#000"/></g><g transform="translate(610 680)"><path d="M215.1 76.6c5-12 9-29.4 24.1-22.5 20.7 9.4 13.9 30.7 9.7 47.4-1.6 6.3-14.5 15.9-18.3 14.3-16.3-6.8-19.2-21.7-15.5-39.2ZM442 113.4c-8.6 7.5-17 7.6-22.2-1.5-9-16-8.6-32.8 3.3-47.2 2.5-3 13.8-3.6 16.3-1 14 15 14.6 31.8 2.6 49.7Z" fill="#000"/></g><g transform="translate(610 680)"><path d="M401.2 30c17.6.1 34.2-.2 50.6.5 9.6.4 19.2 2.3 28.7 3.8 3.4.6 6.2 2.3 7.5 6.1 8.7 25.6 12.5 51.2 1.5 77.2-5.7 13.7-14.6 21-30.8 21.2-26.3.3-52.7 2.5-79.1 2.2-17.3-.1-24.9-5.4-29.4-21.8C347 107 339.6 96 340 82.6c.3-7.3-6.8-8-12.2-8.6-9-1-15.7 2.5-19.6 10.8-2 4.4-1.8 9.2-1.8 13.9 0 14.5-6.9 26.2-15.8 36.6-10.8 12.7-25.9 8.5-39.6 7.5-22.8-1.6-45.6-4.5-68.4-6.4-12.7-1-23-7.7-23-20.4-.3-27.4-15.2-38.4-39.6-45.7-26.6-8-51.9-20.6-77.8-31-9.7-4-21-5.1-27.4-17.2 12.3-2.3 23.3 2 33.4 7a702 702 0 0 0 97 37.1c5.3 1.7 8.3-.4 10.4-4.5 2-4.2 3.2-8.8 5.3-12.9 9.5-18 24.6-24.3 47.4-21.2 22.2 3 44.4 6.4 67 7.4 25 1.2 30.1 7 32.3 28.6 10.5-.8 21-5 32-1.6 3.4 1 5.3-4 6.4-7 8-22.1 26.6-25 46.4-25.3 2.6 0 5.1 0 8.8.2Z" fill="#000"/><path d="M193 63.5c-1-.3 1 0-.2.4-6.6 2 50.7 52.8 55.8 48.5 3-2.5-49.5-46.3-55.7-49ZM213.3 39.7c-.9-.3 1 0-.1.4-6.7 2 50.7 52.8 55.7 48.5 3-2.5-49.5-46.3-55.6-49ZM388.2 63.5c-.8-.3 1 0 0 .4-6.7 2 50.6 52.8 55.7 48.5 3-2.5-49.5-46.3-55.7-49ZM408.6 39.7c-.9-.3 1 0-.1.4-6.6 2 50.7 52.8 55.7 48.5 3-2.5-49.5-46.3-55.6-49Z" fill="#fff"/></g><g transform="translate(774 657)"><path d="M98.9 41.8c6.6-.8 12-1.8 17.5-2.3 4.7-.5 8.2 1.8 10.3 6 1.9 4-1.5 6-3.4 8.8-14.9 21.7-37 16.6-56.8 13-14-2.6-30.4-5.1-37.1-22.7-3.5-9-2.8-12 7.1-13 5.7-.5 11 1.3 16.2 3 14.8 5.1 30.5 7.5 46.2 7.2ZM229.4 42.2c5.6-4 10.8-3 16.4-1.8 17.1 3.5 34.3 5.8 50.2-4.7 4.3-2.9 9.2-3.5 12.7.7 3.2 3.9.3 7.8-1.9 11.6-7 12.4-18.9 16.4-31.4 19.6-10 2.6-20.4 2-30.5 1.4-15.9-1-21.8-11-15.5-26.8Z" fill="#000"/></g><g transform="translate(0 559)"></g></g></svg></div>
             <div class="agent-details">
                <div class="agent-role">Coder</div>
                <div class="agent-name">Implementation & Logic</div>
             </div>
             <div class="thinking-dots"><span></span><span></span><span></span></div>
          </div>

          <!-- PATCH -->
          <div class="agent-card" id="agent-debugger" data-agent-key="debugger" draggable="true" style="--agent-color: #ef4444">
             <div class="agent-avatar" id="av_patch"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1744 1744" fill="none" shape-rendering="auto"><metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:RDF><rdf:Description><dc:title>Notionists</dc:title><dc:creator>Zoish</dc:creator><dc:source xsi:type="dcterms:URI">https://heyzoish.gumroad.com/l/notionists</dc:source><dcterms:license xsi:type="dcterms:URI">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>Remix of „Notionists” (https://heyzoish.gumroad.com/l/notionists) by „Zoish”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id="viewboxMask"><rect width="1744" height="1744" rx="0" ry="0" x="0" y="0" fill="#fff" /></mask><g mask="url(#viewboxMask)"><g transform="translate(531 487)"><path d="M554 727.7c-99.2 297-363.8 388.6-503.7 19.8-19.3-50.7 31-69.5 66.2-91.9 24.1-15.3 36.8-28.5 35.3-42.2-7-64.4-36.9-243.8-36.9-243.8l-3-5.8s.7-1.6-2.2 1.2c-3 3-9.9 34.2-37 34.2-24.5 0-49.2-10.9-61-86.3C7.2 285.6 9.6 214 40 201c12.5-5.3 24-7.2 35.2-.8 11.3 6.4-13-22 112-126C268.4 6.4 396.7-3.5 448.5 8 500.3 19.5 552 44.8 574.9 98.5c27.8 65-25.9 114.3-14 262.5-2.2 53.6.8 171.2-146.6 210.6-28 7.5-19.3 48.4 22.7 58.4 67 21 117 72.3 117 97.9" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="m554 266.2.1-1.4c4.1-36.4 8.2-71.7 27.1-103.4 6.5 4.4 5.7 10 3.7 15.2-19.9 51.2-18 104.4-16.2 157.6l.4 14c2.1 66.4-14.5 126.8-58.7 177.5-15.4 17.6-35.8 29.8-56.5 40.3-21.4 11-25.9 20.1-19.2 43.6l.8 2.6c1.4 3.9 2.8 7.9-1 11.8-4.5 4.6-9.5 3.3-14.8 1.8l-.6-.1a406.4 406.4 0 0 1-137-68.3c-6-4.4-10.8-10.3-15.5-16.1l-.3-.4c-2.5-3-3-7.8.5-10.4 3.3-2.5 5.8-.5 8.7 1.8l1 .9a145.5 145.5 0 0 0 76.3 31.7c13.4 1.4 26.6.9 40 .4 7.4-.3 14.8-.6 22.3-.5 10.2 0 18.7-4.7 26.7-9.2l2.8-1.6c27.8-15.5 54.3-32.8 72.2-60.7 16.1-25 25.9-52.2 31.6-80.9 7.2-36.1 6.6-72.7 6-109.8-.3-12-.5-24.2-.5-36.4ZM50.6 190.8c21.9-1.7 34 11.2 44.3 26.3a140.4 140.4 0 0 1 22.4 61.5c.5 3.7 1 7.6-1.2 11.3-4.5.6-4.9-3-5-5.6-.5-20.7-9.7-38.7-18.9-56.1-6.6-12.5-16.2-24.6-31.4-27.6-17.2-3.5-33 12-40.8 32.2-14.5 37.6-12 74.6 1.4 111 5.8 15.9 13.1 32.1 27.8 43.2 14.8 11.3 32.7 9.3 43.6-5.7l2-2.5c2-2.6 4-5.1 5-8 2.1-5.8 5.4-11.2 11.3-10.4 6.8 1 8 8.3 8.7 14a3661 3661 0 0 0 22 156.7l5.9 38.8c2.6 17.1 5.6 41.7 3.6 52.1a28 28 0 0 0-.3 2.2c-.4 2.8-.6 5-4.2 5.5-4.9.8-7-2-7.7-6.4-2.3-17-3-23.6-4-49.6-.9-25.2-5.6-50-10.4-74.9l-5-27c-5.2-30.8-10.3-62-10.8-97l-2 3c-7.6 11.3-13.7 20.5-24.5 24a40.5 40.5 0 0 1-46.1-12.5 127.8 127.8 0 0 1-28.8-55.8c-8.4-34-9.9-67.1.9-100.6 5.2-16.1 23.7-44.7 42.2-42Zm34.6 127.5c4.4 3.2 8.4 6 12-5.4-1.1-42.2-14.7-69.2-35.8-70.3 11.2 14.6 22 28.8 23 48.5a32.3 32.3 0 0 1-10.7-8.8c-2-2.2-4-4.4-6.5-6l-3-2.4c-4.8-3.6-9.7-7.4-17.8-4.5 3.8 5.8 9 10 14.3 14 6 4.7 12 9.3 15.6 16.5-10.6 7.7-15.2 17.7-9.7 29.9 4.8 10.5 11.9 19.2 25.9 19.8-.6-6.3-4.7-10.9-8.8-15.4-5-5.4-9.7-10.6-7.5-18.6 3.2-1.5 6.2.7 9 2.7Z" fill="#000"/></g><g transform="translate(178 1057)"><path d="M1315.7 690.1 7 691s73-276.9 92.4-308.7c19.4-31.7 97.5-138.7 96.7-156.9-1-18.1 1.4-82.7 14.6-108.2C224 91.6 266 56.6 282.4 54c16.4-2.6 71.6-5.1 106.2-13.7C423 32 455 21.4 490 21.4c5.7 0 .2 12.3.2 12.3S492 154.6 655 162.2C776.6 167.8 816.8 46 816.8 46s-26.7-23.5-18.6-24.2c95.6-8 145.8 13 174.8 18.6 26.7 5.1 49.2 5.1 76 23.9 30.6 21.5 46.5 70.2 80.8 144.8 39.4 85.5 194.2 345 185.9 481.6" fill="#fff"/><g fill-rule="evenodd" clip-rule="evenodd" fill="#000"><path d="M1005.7 694c-.7-16.8-1-33.6-1.5-50.4-.8-36.8-1.6-73.5-6.4-110.3-4.4-33.7-9.4-67.3-15-100.8-9-55-21.3-109.5-33.6-164A302 302 0 0 0 930 214c-5.7-13-10.4-26.2-15.2-39.4-5.5-15.1-11-30.3-17.8-45-1.2-2.5-2.7-4.9-4.2-7.3-3-4.5-6-9.2-7.5-16.2-47.5 92.4-120.5 140.3-223.3 140.7-101.2.5-176-45.6-230.6-128.8a57.7 57.7 0 0 0-16 25.7l-1.4 3.3c-18.6 45.4-36 91-41.5 140.6-3.1 28.6-7.6 57.3-12 85.9l-1.8 11.3c-7 44.7-13 89.6-16.3 134.8A27816 27816 0 0 1 329 693c-4.7 1-9 1-14.5 1 3.5-24.4 4.4-49.3 5.2-74 1.6-49.1 7.3-97.8 13-146.5a6382 6382 0 0 0 4.6-40.2c3-27.7 7-55.3 11-83 4-27.1 8-54.3 11-81.7 5-43.5 22-84.2 40-124.2l.8-1.9c10.5-23.2 20.9-46.2 37.6-65.8C450.5 61.5 465 48 482.4 38c14-8 18.5-6.4 23.1 8.9 9.6 31 26.3 57.8 53.3 76 42.8 28.8 89.1 41.8 141.4 26.6 36.4-10.5 66.6-28.8 88.3-59.5 8.4-12 16-24.7 18.5-39.6l-5.6-2.1c-4.3-1.6-8.5-3.1-12.6-5-3-1.2-6.7-2.9-5.2-7.3 1.3-3.3 4.2-5.8 8-5.3 33 4.5 64.4 11.7 86.3 40.7a341.9 341.9 0 0 1 47.4 88.3l7.5 20c12.6 33.4 25.1 66.8 34.4 101.2a645 645 0 0 1 9.1 41.3 1517 1517 0 0 0 3.6 17.6l5.2 23.5c4 18 8 36 10.9 54 2 12.5 4 25 6.2 37.5 6.1 35.4 12.2 70.9 13.8 107 .8 17.8 2.1 35.5 3.4 53.3 1.1 15 2.2 30 3 44.9.5 8.1-.4 16.3-1.2 24.8l-.8 8.4c-4.9.7-9.8 1-14.7.8ZM820.6 60.5c-8 18.2-15.8 36.5-29.3 51.7-34.3 38.7-78.8 56.4-129.4 57.9-34.1 1-67.6-6-97-24.7-28.6-18.2-53-40.3-65-73.3l-1.3-3.6c-2-5.8-4-11.8-8.6-15.8-13.2 3-16.7 11.1-14.6 22.7.4 1.8.6 3.8.9 5.7.5 4 1 7.9 2.4 11.5 12.5 35 37 60.8 68.3 79.6a204.4 204.4 0 0 0 80.8 28.2c60.4 7.4 116.6-.5 166.4-37.4 30.3-22.4 48.9-52 53.4-89.5 1.7-14.8-7.2-21.7-24.7-18.4l-2.3 5.4ZM459.3 76c20 81 77 120 153.7 137 39 9.8 76 8.1 113.2-1.4 41.3-10.6 77.6-29 104.8-62.4 16.6-20.5 28.9-43.2 29.3-70.8 15 7.8 16.5 13 6.5 31.6a227.7 227.7 0 0 1-96.7 96.8c-46.4 23.8-96.3 30-148.6 22.3-54.1-8-98.7-33.3-137.7-69.6-14-13-24.7-29-35.2-44.9l-6.8-10.1c-2.7-4-1-7.2 1.7-10.3L454.2 82l5-5.8Z"/><path d="M215.1 694c4.5-15.3 6.2-31 8-46.9.8-7.9 1.6-15.8 2.8-23.7l2.7-17.9c3.6-23.9 7.1-47.8 12.5-71.5l4.8-20.4c3.2-13.1 6.4-26.3 8.8-39.7 4-22.8 10.7-45 20.3-66a246 246 0 0 0 22.3-101c.3-17.5 2.5-34.7 4.7-52 1.6-12.8 3.3-25.6 4.1-38.5 1.6-24.4.4-48.5-1-74.8-3.9 3-7.5 6-11 8.9-7.6 6-14.8 11.9-22.1 17.4-42.9 32-76.3 72.4-105 116.8-11 17.3-20.4 35.7-29.8 54-3.7 7.5-7.5 14.9-11.4 22.2a819.3 819.3 0 0 0-40.2 93.2l-6.5 17c-17.8 46.4-35.8 93.2-42.8 142.8-2 14.2-6 27.9-9.9 41.7-3.5 12.2-7 24.5-9.3 37.4-5.5 1-10.8 1-17.1 1l2.8-9.7c8.4-29.2 17-58.5 21.3-89 2.2-15.4 6.7-30.6 11.1-45.6l3.1-10.4a539.5 539.5 0 0 1 16-45c5-13 10-25.9 14-39.1 5-15.7 11.6-30.9 18.2-46l7.2-16.8a996.4 996.4 0 0 1 59-115l.4-.6c7.4-12.7 15-25.8 26-36.3 8.7-8.2 9.2-18.8 9.7-29.3.2-4 .3-8 1-11.8l1.3-8.1c5-31.4 10.2-63 26.3-90.8 16.7-29.1 44.5-45.3 77-53C318 41.7 342 38 366.3 36.6c10-.7 19.7-3.8 29.6-7 5.2-1.6 10.5-3.3 15.8-4.6 5-1.2 10-2.6 15-4 19.2-5 38.3-10.1 58.5-9.2h1c4.1.1 8.3.3 9 5.4.6 5-3 5.7-6.6 6.4l-2 .4-42 9.8c-26.4 6.2-52.8 12.5-79.4 18.2a243.5 243.5 0 0 1-35.4 4c-3 .2-6 .3-8.9.6a49 49 0 0 0-23.7 6.2c25.8 16 41 37.4 40.5 68-.2 18 .5 36.2 1.3 54.3 1 23.8 2 47.6.6 71.5-1.7 31-5.3 62-9.9 92.8-2.7 17.9-4.8 36-6.8 54-2 17-4 34-6.4 50.9-2.5 16.8-4.2 33.8-5.8 50.7-1.6 15.6-3 31.3-5.3 46.9-2.5 18.3-4.4 36.6-6.2 55-1.6 16-3.2 31.8-5.3 47.6-.5 4-.8 8.1-1 12.2-.5 8.6-1 17.3-4.1 26.2-5.6 1-11.3 1-17 .1a754 754 0 0 0 16.7-100l.5-3.8c2-16.3 3.4-32.6 4.8-49 2.4-26.7 4.7-53.4 9.4-79.9 1.8-10.6 2.7-21.4 3.5-32.2 1-14 2.2-27.9 5.5-41.6 8.3-34.4 11-69.8 13-104.9 2.8-51.6 3.5-103.6.3-155.3-1-16.4-4.6-33-19.5-46.4 1.5 4.9 3.3 9.6 5 14.1 3.7 9.7 7.2 18.8 8 28.2 2.5 27.1 2.7 54.5 2.2 81.8-.5 31.9-4 63.5-7.6 95.1l-3.5 32.9c-3.6 35.8-8.8 71.4-13.9 107-2.3 15.9-4.6 31.8-6.7 47.6-2 14.4-3.5 28.8-5 43.2-1.8 17.3-3.6 34.7-6.2 51.9-1.6 11-2.6 21.9-3.6 32.9-1.6 18.3-3.3 36.6-7.9 54.5l-1 3.7c-1.9 6.7-4 13.9-.5 21-5.6.2-11.2-.1-16.7-1 .7-7.7 2-15 3.1-22.4 1.1-6.5 2.2-13 2.9-19.4 1.4-13.5 3-27 4.5-40.4l5-44.7c3-28.7 6.8-57.2 10.7-85.8l4.9-36.5c-1.9 8-4.3 15.9-6.7 23.8a249 249 0 0 0-8.8 34.2c-2.7 16.5-6.1 33-9.6 49.3-4.5 21.3-9 42.7-11.7 64.4-.9 7.5-2 15-3 22.4-2.8 18.6-5.6 37.2-5.4 56.2h-19.3Zm60.3-548.3a93.6 93.6 0 0 1 20.5-16.8c6.7-3.8 8.5-9.9 6.1-16.2-1-3-1.6-6.4-2-9.7-1.1-7.8-2.3-15.6-11.6-19.6-5-2-9.9-.2-13.3 2.3a70.5 70.5 0 0 0-17.5 16.4c-17.2 25.7-26.6 54.6-35.6 87.3 11-10.8 22.1-19.3 33.3-27.8 6.7-5.2 13.4-10.3 20-15.9Zm-37.6-39.6c-9.9 23.3-19.7 46.6-22 72.1-.3 13-5.7 22.1-11.5 31l3.8-17.8c6.8-33 13.6-66.1 33.8-95l-4.1 9.7ZM1280.7 550.3c15.9 46.5 24.2 95 31.7 143.7 5.5 0 10 0 14.6-1.1-4-38.9-12.7-75.9-21.4-112.8l-.2-.5c-4-17.4-9.8-34.3-15.6-51.3l-5-14.8c-13.3-40.2-27-80.3-43.7-119.3-8.8-20.5-19.6-39.9-30.4-59.3-4.7-8.4-9-17-13.3-25.4-9.4-18.6-18.9-37.2-31.8-54l-4.1-5.1c-5.8-7.3-11.8-14.7-14.6-23-11.3-34.3-24.2-68-37.1-101.6a153.5 153.5 0 0 0-32.8-53.3c-20.4-20.8-47.9-28.3-75-34.7-23-5.3-46.2-9.9-69.3-14.4l-40.4-8a358 358 0 0 0-104-6c-5.4.5-9.9 1.7-11.8 10.5 14.5 1.6 29 2 43.6 2.4 24.2.6 48.4 1.3 72.4 7.7 25.2 6.8 51 12.2 77.4 17.7l37.9 8c-9.1 9.7-9.4 19.2-9.7 28.7l-.2 4.5c-.8 13.9 1.4 27.4 3.5 41 1.5 9.2 3 18.5 3.5 27.9 2.4 44.3 9.6 87.9 16.8 131.5l1.4 8.3c3.4 21 6 42.2 8.5 63.4a1599 1599 0 0 0 7.4 56.3c4.7 30.7 6.5 61.7 8.2 92.7 1.1 21 2.3 42.1 4.4 63.1 2.1 20.8 3.7 41.7 5.2 62.7 1.4 19.4 2.8 38.8 4.7 58.2h11.7c-.5-48.6-4.2-97-7.8-145.5a4327 4327 0 0 1-5.2-74.6 752.8 752.8 0 0 0-7.1-61.9c-1.5-10.6-3-21.2-4.3-31.8-3.8-31.4-8.8-62.5-13.8-93.7-4.2-26.9-8.5-53.7-12-80.7-1.8-13-4-26-6-38.9-4.5-26.8-9-53.7-9.4-81a31 31 0 0 1 12.6-26.7c-14.6 29.7-8.2 58.4-1.9 87 1.7 7.6 3.4 15 4.7 22.5 1 6.6 2.5 13.2 3.9 19.8 2.7 13.2 5.5 26.4 6.3 39.8.6 11 2.7 21.7 4.8 32.3 1.5 7.4 3 14.9 3.9 22.4 2.4 19.6 5.6 39 8.8 58.4 5 30.3 10 60.6 12.2 91.3a655.6 655.6 0 0 0 12.8 82c2.4 12.7 3 25.6 3.4 38.1v2c.8 18.4 2.5 36.5 4.2 54.7 2.3 23.7 4.6 47.4 4.5 71.2l-.2 4.4c-.2 2.4-.4 5-.2 7.9 3.8.8 7.6 1 11.4 1 2.8-44.8-.4-89.4-4.4-136.4 14 39.4 21 78.4 28 118l3 17.3c5.5 1 11 1 16.5.2-3.9-8.7-4.6-17.7-5.2-26.4-.4-5.6-.8-11-2-16.4l-3.3-14.4c-7.8-34.7-15.7-69.4-30-102.4-1-2.2-2-4.5-3.2-6.8-3.7-8-7.6-16.1-8.3-25-1-14.8-4-29.3-7-43.7l-2.5-12.2c-3.6-18.3-5.7-36.8-7.8-55.3-2.1-19-4.3-38-8-56.7-3.8-18.6-7-37.3-10.2-56-5-29.2-10-58.4-17-87.3l-2-8.3c-2.9-11.5-5.9-23.5-6.7-36.5l4.4 1.5c2.4.8 4.2 1.4 5.7 2.5l1 .8c31.3 23.8 62.6 47.7 87.2 78.6 21.4 27 40.5 55.2 55.9 86.3 5.9 12 12 23.7 18.1 35.5a939.8 939.8 0 0 1 37.1 77c11.7 28.7 21.3 58 31 87.2l11.6 35.2ZM1037.2 132c-6.2-3.4-10.4-8.1-11.5-15.2a63.7 63.7 0 0 1-2.9-33c2.2-15.1 12.8-19.4 26.5-13 20 9.3 28.7 27.3 37.2 44.8l2.6 5.5c8.3 16.6 15 34 22.2 52.6l10.1 25.7-11.5-10.7a451.6 451.6 0 0 0-55.4-46.2 269 269 0 0 0-17.3-10.5Z"/></g><path d="M428.7 11.3c45.2-21.2 59.5-10 59.5-10s-1.3 12.1 7.9 43c19.2 65 123.7 66 159 61.8 37.1-4.5 125.8-30.2 131-51.7 10-42-16.9-45.2-.8-46.5 16.1-1.4 85.1-.8 133 74.3 2.4 3.8 49.2 152.1-2.5 152.1-27.2 0-68.7-80-96.5-54.7a306 306 0 0 1-191 79.8c-52.3 2.6-140.8-43.6-140.8-43.6l-50-30.2s-55.5 41.3-74.7 30.9c-25.2-13.7 2-164 2-164s24.6-22.7 63.9-41.2Z" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="M362.5 41.8S422.6 1.9 459-5.3c19.5-4 28.3-5.3 38.6 8.6a28.5 28.5 0 0 1 4.8 15.6l.2 2.2a78 78 0 0 0 35.2 58.7 87 87 0 0 0 39.5 13C626.6 98 676 98.7 723.7 83A142 142 0 0 0 777 54.3c9.4-8.6 9.5-14.9 0-23.1-3.7-3.3-2.6-6-1.3-9.1.4-1 .8-2 1-3.1C781 1.4 782-.2 801.1 2c29 3.5 58.4 10 80.4 29.2 59.6 52.1 59.8 81 60.1 154 0 10.5.1 22 .4 34.7.2 12-6.8 17.9-18.6 19.6-23.3 3.5-39-5.8-50.4-25.4-4.6-8-10-15.6-17.7-21.4-16-11.7-25.6-12.4-40.5 0a312.3 312.3 0 0 1-119.6 62.5 259.6 259.6 0 0 1-184-16 156 156 0 0 1-49.8-33.7c-4.6-5.1-10.7-8-17.1-6.5l-4.8 1.1c-14.9 3.4-29.8 6.9-42.7 15.8a39.9 39.9 0 0 1-39.6 4.8c-12.1-5.4-11.8-18.7-10.7-30.2 1.4-13 2.3-26 3.2-39 2-29.6 4.1-59.4 11.3-89-11.7 1.3 1.5-20.7 1.5-20.7ZM494 155.6c41.2 27.3 86.7 37 136 37.2 49.4 0 95.2-8.8 139-34.4-30.9-17.7-26.5-42.3-16.5-69.3L742 91.8c-6.7 1.6-12.7 3.1-18.4 5.2-23.7 8.7-48.8 11.7-73.3 14.6-32.9 3.7-66-2-98.1-9.9a78.7 78.7 0 0 1-43.7-24.5c-2.5-3-4.3-6.3-6-9.7-2.6-4.7-5-9.5-9.5-13.1a11.5 11.5 0 0 0-.2 12.3c2.5 4.1 4.8 8.3 7.2 12.5 7 12.3 14.1 24.7 22.7 35.8 6.4 8.3 7.5 15.8 7.2 26.7-15-3.4-29.3-6.5-42.3 2.5-.1 4 2 6.4 4.8 9.5l1.6 1.9Zm274-58.8 2-3.2c3-5.6 7-10 11-14.4 5.7-6.2 11.2-12.2 13.2-21 3.4-15 6.5-29.1-.5-42.2 2-3.7 4.3-4.5 6.3-4l7.6 2c31 8.2 62 16.2 82.8 44.4a169.2 169.2 0 0 1 34.4 85.3c2 20.9 4 41.8 5.2 62.7 0 1.3.2 2.6.4 4 .8 6.4 1.7 13.3-7.5 16.4-11.2 3.8-25.7-.7-31.7-10-1.7-2.7-3.1-5.5-4.6-8.3-1-2-2.1-4.1-3.3-6.1-18.8-32.3-49.1-50.1-83-62.4-8.7-3-19.3-1.8-29-.7h-1l-.4.2c-9.8 1-11.3-3.6-12.4-11.3-1.9-12.6 4.2-22 10.4-31.4ZM362.7 196c.9 14 4 17.4 13 12.3l7.4-4.3c16.4-9.3 32.7-18.4 43.8-35.7a89.3 89.3 0 0 1 52.5-39.6c6.1-1.6 12.3-1.6 18.4-1.6 4.7 0 9.4 0 14.1-.6-.8-4.7-3.2-7.6-5.5-10.5l-1.8-2.2C484 86.3 467.9 57.1 472 21.1c.8-6.9-3.5-8.5-8.1-8.3-9.3.4-18.3 1.5-27.3 4.8A230.1 230.1 0 0 0 406.1 32c-6 3.2-12 6.4-18.2 9.3-6.8 3.2-14 8.1-14 16.8.1 9.6-1.9 18.8-3.8 28-1 4.4-2 8.7-2.6 13a501.2 501.2 0 0 0-4.6 80.2l-.1 16.6ZM599 206.6c34 5 67 .2 100.2-5a258.2 258.2 0 0 0 75.9-30c8.9-5.3 19.2-4.5 30.3-3.5 4.5.3 9.1.7 13.9.7-15.4 16.7-32.6 27.4-49.6 38l-4.1 2.6a229 229 0 0 1-83.5 32.9c-30.3 5.1-60.6 8.7-92.2 4.2a230.6 230.6 0 0 1-94.4-33.9c-17.9-11.5-35.3-24.3-47.7-42.4 18.7-12.3 26.9-11.6 44 .2 32 22.3 69 30.7 107.2 36.2Z" fill="#000"/><g transform="translate(396 278)" style="mix-blend-mode:difference"><g fill="#fff"><path d="m302.9 264.7-.5.1h.5Z"/><path d="M410.3 250c-3-10-7.3-19.7-13-28.5a217.4 217.4 0 0 0-24.8-32.8 410 410 0 0 0-64.7-54.4 371.2 371.2 0 0 0-53.1-30A199.3 199.3 0 0 0 188 83.5c-12-.9-24.3-.1-36.2 2.3 11 1 22 2.8 32.7 5.4 14.8 4 33.2 11.6 49.3 18.1 20.5 9 40.7 18.8 59.8 30.5 29.6 19 53.5 38 76.8 62.8 12.4 14.3 20.5 25 28.4 40.5 3.7 8 6.4 16.6 8 25.3.8 6.1.7 5 .8 8.6v1.4l-.4 2.8v.1a44.4 44.4 0 0 1-19.2 27.3c-26.3 17-53 25.7-84.3 24.3-20.5-.8-41.7-6-58.8-10.7a385.2 385.2 0 0 1-61.8-22.6c-17-8-33.5-17.2-48.2-29-16.7-13.3-31.1-24.6-45-42.6-9.2-11.8-14.4-19.2-19.9-33l-.8-2.5c-1.6-5.4-1-2.5-1.7-8.3.2-3.5-.8-8 2.4-13.3a63 63 0 0 1 33.3-24c7.4-2.3 21.7-4.6 32.5-4.7 8-.1 16 1.2 23.9 2.4 15.7 2.8 28.7 6.9 44.7 13.5 14.7 6 29 12.8 42.9 20.4 29.1 16.6 63 42.2 70.4 67.4l.4 1.6v.2c.3 1.2.5 2.5.6 3.7v.3a114.5 114.5 0 0 0-.2 1.7l-.3 1.3c-1.5 4-7 7.6-15.3 10.1h-.3l-.3.2h.1a86 86 0 0 1-16.3 1.6c-9.5.1-18.9-1.6-28-3.8a126.6 126.6 0 0 1-38.1-15.5 189 189 0 0 1-26.9-18.4c-5.9-5-11.6-10.3-16.3-16.6-2-3-2.9-4.1-3.9-7.7a39.8 39.8 0 0 1 .2-.8l.2-.3v-.2l1.2-1.3.3-.4.3-.2c2.8-1.9 5.9-3.3 9-4.3 4-1.1 8.2-1.7 12.3-1.7a100.8 100.8 0 0 1 45.5 11.7 103 103 0 0 0-11.2-8.6c-12.8-8.2-29.1-15.6-44.6-14.2-12.4 1.7-19.9 6.7-20.1 20-.2 12.2 8.1 22.3 16.5 30.3 6.3 6 13 11.6 20.3 16.6a213.5 213.5 0 0 0 34 19c7.7 3 15.6 5.5 23.7 7.2 9.6 2.2 19.5 3.6 29.3 3 6.7-.3 13.5-1.1 19.7-3.8 25-9.7 16.6-42 3.8-58.7a158.2 158.2 0 0 0-36.9-35.3 284 284 0 0 0-51.1-29.7c-14-6.3-28-12.5-42.8-16.8a209.3 209.3 0 0 0-39.5-7.7c-7.8-.4-15.6 0-23.2 1.1A76.8 76.8 0 0 0 77.2 147a49.5 49.5 0 0 0-13 15.9 49.1 49.1 0 0 0-3.4 24c1.6 18.5 11.9 35 22.9 49.6a187.5 187.5 0 0 0 30.9 32.4c11.3 9.5 22.6 19.1 35 27 25.6 16 53.7 27.7 82.4 36.6 28.4 8.3 57.8 16 87.6 14.2a144 144 0 0 0 75.9-29 55.6 55.6 0 0 0 19-35.6 90 90 0 0 0-4.2-32Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M528.4 299.2c2 3 4 6.1 4.8 9.6 1 4.7 1.3 11-3 14.2-2.5 1.4-5.6 1.7-8.5 2l-1.4.1c-5.3.4-10.6.5-15.9.4h-.4c-2.8 5.2-5.5 10.5-8 16 1.3-5.1 3-10.6 5-16.2a213 213 0 0 1-8-.5 142.3 142.3 0 0 0 3.3 8.2l-.5-.7-.6-1c-1.4-2.1-2.8-4.3-4-6.6a126.6 126.6 0 0 1-26-5c-5-1.5-10.6-3.3-12.2-8.7-1.3-5-.3-11 4.2-14a142 142 0 0 1 18.1-12.4c-.7-3-1.4-6.3-1.8-9.5-.7-7.3-1.7-22.4 9-22.2 4.4 1 7.9 4 11.2 6.8l1.6 1.3a150.9 150.9 0 0 1 8.8 8.5c3.8-1.7 7.7-3 11.6-4.2 3.1-.8 6.4-1.4 9.5-.4 3.8 2 4 7 3.5 10.8-.5 2.8-1.4 5.4-2.7 7.9l-3.5 7.1c2 2.6 3.8 5.3 5.6 8l.3.5Zm-8.8-20.8c-1.7.3-3.4.7-5 1.3l-.4.1-.5.2 3.6 4.2 2.4-5.8Zm-37.2-11.6 4 2c2.5 1.8 4.9 3.7 7 5.8a349 349 0 0 0-12.5 6.8 58.4 58.4 0 0 1-1-14.2l.8-.4h1.7Zm-3.3 30.2c-4.7 2.7-9.4 5.6-13.8 8.7 6 2 12.4 3.4 18.8 4.2a244.4 244.4 0 0 1-5-13Zm9 13.4-4.3-16v-.1l2.8-1.6c5.4-3 11-6 16.6-8.5a222 222 0 0 1 9.6 10.8l-6.6 16.5c-6 0-12.2-.4-18-1Zm29.3-9.7-5.8 10.8c4.3 0 8.6-.3 12.9-.8l-.9-1.4c-2-2.9-4-5.8-6.2-8.6Z"/><path d="M262.6 221.8c2 6.7 3.6 10.8-3.4 12.4-5.4 1.1-11 .5-16.4.4-.8 0-1.1 0-.2.3a45 45 0 0 0 9.6 3.6c12.6 3.2 17.6-6.8 10.4-16.7ZM412.8 353.9c-4.7 2.5-9.9 4.1-15 5.8a237 237 0 0 1-21.2 5.6 261 261 0 0 1-58.3 5c-22.6-1-45-4.8-66.8-11-18-5-45.7-11.8-72.3-22.3l-5.7-2.3a851 851 0 0 0 56.3 29.5 196.2 196.2 0 0 0 55.3 16.5c18.7 3.2 37.7 4.2 56.7 3 10.3-.6 20.8-1.6 30.9-4.3a134 134 0 0 0 39-17.4c8.7-6.3 15-15 21.4-23.6-6.6 5.7-12.6 11.2-20.3 15.5ZM391.5 147.3l-4.2-2.4 7.3 7a340.7 340.7 0 0 1 50.5 71.3c-8.6-31-23-61.4-53.6-76ZM18.6 152c5.3-8.4 19-25 29-31.4A100 100 0 0 1 75.5 106a95.2 95.2 0 0 1 21.2-2.5 69.2 69.2 0 0 0-23.6-2.9A78.2 78.2 0 0 0 44 111c-13.7 8-24 20.7-32 34.1a89.6 89.6 0 0 0-11 45c.8 19.6 8 38.5 18.3 55a300 300 0 0 0 38 44.2l15.1 14.5A518 518 0 0 1 27.1 242c-14.5-23.5-21.2-43.7-18.5-62.6a64 64 0 0 1 10-27.5Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M134.7 341.1c-1.8-3-3.7-6-5.8-8.9l-.6-.7-.5-.6 1.4-2.6c1.3-2.1 2.5-4.3 3.3-6.7.8-3.5.8-8.2-2.3-10.6a7 7 0 0 0-4.4 0 43.7 43.7 0 0 0-11.4 4.2A264.7 264.7 0 0 0 91.6 294c-1-.9-2.1-1.8-3.4-2.4-3.5-1.4-5 3.2-5.3 5.8a64.1 64.1 0 0 0 2.5 20.5c1 4.3 2.3 8.6 3.7 12.8l-4 2.8-.7.5-9.8 7c-3 2.3-6.4 4.9-7 8.9-.7 3.5-.5 8.3 2.9 10.4 3.6 1.2 7.5 1.5 11.4 1.8l2.4.2c5.3.4 10.6.4 16 .1 2.3 6.7 4.7 13.4 7.3 20 .2.9.7 1.7 1.3 2.4-.7-1.2-1-2.6-1.2-4l-.4-1.9-1.5-6.5-2.2-10.2c2 0 4.1-.2 6.2-.4-1.2 4.6-2.1 9.4-2.7 14.1 1.4-4.9 3.1-9.7 5.1-14.3a464.7 464.7 0 0 0 10.6-1.2l7.8-1c1.2-.2 2.4-.6 3.6-1a7 7 0 0 0 2.4-3c2-4.7.8-10-2-14.2Zm-44-32.9c4.8 4 9.3 8 13.6 12.4l-9.4 6c-1.7-6.7-3.2-13-4.2-18.4Zm2.5 34.4-8.4 5.7c3.5.2 7 .3 10.5.2l-2.1-6Zm7.3 5.8-2.3-9.2 4.7-3c3.1-2 6.8-4.2 10.5-6.2 1.6 1.8 3.4 3.7 5 5.7a230.1 230.1 0 0 0-4.3 11.6c-4.5.5-9 .9-13.6 1Zm19.8-3.5-1 1.9 7.2-1c-1-1.5-2.5-3.3-4-5.2l-.5 1-1.7 3.3ZM380.5 75.7c-1.2-2-3-3.5-5.2-4.4l-8-3.8c.3-14 .3-27.9-.3-41.8-.3-2-1.1-5.4-3.7-4.6a17.3 17.3 0 0 0-3.6 5 341 341 0 0 1-19.6 29.4 646.9 646.9 0 0 0-43.3-16.7c-1.8-.6-3.6-1.2-5.3-.4-4.3 3.3-3.8 10.2-1.7 14.6a64 64 0 0 0 9.8 12.5l.2.2c5.4 5.8 11.2 11.1 17 16.4l1.6 1.4 1 1a5872 5872 0 0 1-15 9.4 27 27 0 0 0-5.7 4 6 6 0 0 0 0 6.6 3 3 0 0 0 2.6.8c1.5 0 3-.3 4.6-.5 5.1-.9 10.2-2 15.3-3.1l5-1.2 9-2a3942 3942 0 0 0 12.6 11.1c4.2 3.7 10.2 9 14.2 5.6 3.4-3.3 3.8-8.2 4.1-12.7l.2-2.3.5-8.6 6.2-1.2c.5 0 1-.2 1.4-.3 1.4-.3 2.8-.6 4-1.3 4-2.9 4-9 2-13Zm-20-12.7v1.4l-9.3-4.1 5.6-6a57 57 0 0 0-8.4 4.8 242.4 242.4 0 0 1-4-1.7l-1.4-.6c6.5-6.2 12.5-12.8 18-19.8-.3 7.4-.4 16.6-.5 26Zm-55-7A1166.6 1166.6 0 0 0 337 85a225.8 225.8 0 0 1 23.2-6v-.5c-5.7-2.6-11.5-5-17.3-7.5l-3.5-1.5a55 55 0 0 1-5.6 3 94 94 0 0 1 3.5-3.9l-5-2.1a54 54 0 0 0-.7.6l.4-.5.1-.2c-8.8-3.6-17.6-7.2-26.6-10.5Zm5 38.4c3.3-3 6.5-6.2 9.6-9.4l4.5 4.1a556 556 0 0 0-14 5.3Zm38.5 1 1.8 1.7 1 .9c1.5 1.2 3.7 3.2 6.7 4.4h.5c.3-2.6.6-5.7.7-9.3L349 95.4Z"/></g></g></g><g transform="translate(266 207)"><path d="M304 281.5a44 44 0 0 1 14.7-13.4c9.7-6 18.3-13.6 25.5-22.5 8.4-10.5 21.6-16.2 34.5-20.7 9.5-3.2 15.2-7 17.2-18.7 2.5-14.7 17.7-19.1 30-22.4 38.7-10.2 72.9-28.8 105.8-51a343.3 343.3 0 0 1 88-43.2c24.8-7.8 49.2-11 74.2-8.6 31.5 3 61.8 12.5 81.3 39.2 21.4 29.3 28.9 63 19.7 99-2.2 8.6-4.9 17.1-7.6 26.8 11 9.5 25 16 35.7 27 11.7 12 21.6 24.6 26.6 40.7 1.2 4 3.5 8.6 2.6 12.3-4.7 18.6 8.7 35.7 9.9 53.6 2.4 36.4-21.4 94.6-23.7 95.7-1-5.7-10.2-2.7-7.6-12 6.6-23.5-6.8-58-9.6-74.4a58.4 58.4 0 0 0-21.2-37.3c-91.2-76.2-90.1-76.3-187.6-43.4-31 10.5-57.3 30.9-85 47.8-6.9 4.1-12.5 9.7-20.6 12.5-16.9 5.7-22.6 2.9-24.4-15l-.9-5c-9.6-.7-15.3 5.7-21.2 10.8-28.1 24.5-48 52.6-40.9 92.9a33 33 0 0 1-4.7 20.9c-14.5 26.4-18.3 55.3-20 84.6-.6 9-4 14.5-13 16-10 1.8-10.8-5.5-13.5-12.6-7.8-20.4-10.6-42.7-25.2-60.4-12-14.6-25-24.4-44.8-15.7-10.2 4.4-14.9-2.9-20-9.1-15.7-19.6-19.7-42.8-20.6-67-1.7-45 11-85.3 39.6-120.4 1.8-2.3 4-4.3 6.8-7Z" fill="#000"/></g><g transform="translate(791 871)"><path d="M155.6 137.2c-8.8 0-16.5.5-24-.4-5.1-.6-10.4-3.4-9-10 1.4-5.5 6-6 11.3-5.2 6.6 1 13.4 1.2 20.2 1.5 4 .2 8 .8 9.2 5.2 1.5 5.3-2 7.7-7.7 8.9Z" fill="#000"/><path d="M179.7 92.3c8.6 7.2 17 7.6 26.6 1.3 10-6.6 12.9-15.7 13.3-28A685.6 685.6 0 0 1 67.5 55.3c5 6.8 12.4 3.6 13.8 11.8 3.5 19.1 12.4 23.6 30.6 17.1 5.6-2 9.2-2 12.7 3.8 11 18.5 24.8 21.2 42.1 8.8 3.5-2.4 6.4-5.7 13-4.6Z" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="M206.9 53.5c-3.8.3-7.6.6-11.5.1-10.4 1-20.2-.1-29.8-1.3-5.3-.6-10.6-1.2-15.9-1.4-27-1.3-54.1-3.6-81.2-6l-1.9-.2c-5.2-.6-10.5-1.1-13 3.7-3 6.1 0 12.6 5.2 17a72 72 0 0 1 16.6 20c7 12.3 18.7 17 32.4 14.7 6-1 9.7.7 13.5 4.4a38.7 38.7 0 0 0 52.9 3.2c3.8-3 7.3-4.6 11.4-2.3 13.2 7.4 24.1.6 34.4-6 15.1-9.5 18.3-32.3 6.2-42.3-5.7-4.7-12.3-4.2-19.3-3.6Zm-.6 40.1c-9.7 6.3-18 5.9-26.6-1.3-5.6-1-8.6 1.3-11.5 3.5l-1.5 1.1c-17.3 12.4-31 9.7-42-8.8-3.6-5.8-7.2-5.8-12.8-3.8-18.2 6.5-27.1 2-30.6-17.1-.8-4.6-3.4-5.6-6.5-6.8-2.4-1-5.1-2-7.3-5 51.6 9.6 101.2 12 152 10.1-.3 12.4-3.1 21.5-13.2 28.1Z" fill="#000"/></g><g transform="translate(653 805)"></g><g transform="translate(901 668)"><path d="M65.7 43.5c-4.3 23.6-7.3 45.8-.3 68.8A79.4 79.4 0 0 0 98 157.1c22.3 14.8 22.7 43 .4 57.5-24.6 16.2-50.8 14-77 7.5-11.8-3-17.9-14.2-21-25.4-2.7-9.6 6.5-25.2 16.6-31 3.1 3.8 2.4 7 .2 11.3-6.7 12.3 0 31.4 13.5 32.6 19.8 1.7 40.7 5.8 59.1-8 12.5-9.4 14-21.5 1.8-31.4-7.3-5.9-14.4-11.7-20.6-18.8-28-31.7-29.9-68.2-20-107 3.5-14.3 9.2-27 19-38C73 3 76-.9 80.5 2c5.9 3.9 1.2 8.4-1 12-5.6 9-10.6 18.3-13.8 29.5Z" fill="#000"/></g><g transform="translate(610 680)"><path d="M407.4 122.5c13 .3 25.4 1.1 37.6 2.5 3 .4 5 3.3 5 6.7 0 3.3-1.7 5.6-4.7 7-11.2 4.8-22 8.2-33.7.2-6.5-4.5-9-8.7-4.2-16.4ZM247.6 117c7 0 7.8 3.8 7 8.5-2 10.2-20 22.4-30.4 20.5-5.9-1-10.5-4-10.7-10.5-.2-6.7 4.8-8.2 10.3-8.4 9-.3 15.8-5.2 23.8-10ZM215.1 76.6c5-12 9-29.4 24.1-22.5 20.7 9.4 13.9 30.7 9.7 47.4-1.6 6.3-14.5 15.9-18.3 14.3-16.3-6.8-19.2-21.7-15.5-39.2ZM442 113.4c-8.6 7.5-17 7.6-22.2-1.5-9-16-8.6-32.8 3.3-47.2 2.5-3 13.8-3.6 16.3-1 14 15 14.6 31.8 2.6 49.7Z" fill="#000"/></g><g transform="translate(610 680)"></g><g transform="translate(774 657)"><path d="M98.9 41.8c6.6-.8 12-1.8 17.5-2.3 4.7-.5 8.2 1.8 10.3 6 1.9 4-1.5 6-3.4 8.8-14.9 21.7-37 16.6-56.8 13-14-2.6-30.4-5.1-37.1-22.7-3.5-9-2.8-12 7.1-13 5.7-.5 11 1.3 16.2 3 14.8 5.1 30.5 7.5 46.2 7.2ZM229.4 42.2c5.6-4 10.8-3 16.4-1.8 17.1 3.5 34.3 5.8 50.2-4.7 4.3-2.9 9.2-3.5 12.7.7 3.2 3.9.3 7.8-1.9 11.6-7 12.4-18.9 16.4-31.4 19.6-10 2.6-20.4 2-30.5 1.4-15.9-1-21.8-11-15.5-26.8Z" fill="#000"/></g><g transform="translate(0 559)"></g></g></svg></div>
             <div class="agent-details">
                <div class="agent-role">Debugger</div>
                <div class="agent-name">Analysis & Repair</div>
             </div>
             <div class="thinking-dots"><span></span><span></span><span></span></div>
          </div>

          <!-- QUILL -->
          <div class="agent-card" id="agent-data" data-agent-key="data" draggable="true" style="--agent-color: #f59e0b">
             <div class="agent-avatar" id="av_quill"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1744 1744" fill="none" shape-rendering="auto"><metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:RDF><rdf:Description><dc:title>Notionists</dc:title><dc:creator>Zoish</dc:creator><dc:source xsi:type="dcterms:URI">https://heyzoish.gumroad.com/l/notionists</dc:source><dcterms:license xsi:type="dcterms:URI">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>Remix of „Notionists” (https://heyzoish.gumroad.com/l/notionists) by „Zoish”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id="viewboxMask"><rect width="1744" height="1744" rx="0" ry="0" x="0" y="0" fill="#fff" /></mask><g mask="url(#viewboxMask)"><g transform="translate(531 487)"><path d="M554 727.7c-99.2 297-363.8 388.6-503.7 19.8-19.3-50.7 31-69.5 66.2-91.9 24.1-15.3 36.8-28.5 35.3-42.2-7-64.4-36.9-243.8-36.9-243.8l-3-5.8s.7-1.6-2.2 1.2c-3 3-9.9 34.2-37 34.2-24.5 0-49.2-10.9-61-86.3C7.2 285.6 9.6 214 40 201c12.5-5.3 24-7.2 35.2-.8 11.3 6.4-13-22 112-126C268.4 6.4 396.7-3.5 448.5 8 500.3 19.5 552 44.8 574.9 98.5c27.8 65-25.9 114.3-14 262.5-2.2 53.6.8 171.2-146.6 210.6-28 7.5-19.3 48.4 22.7 58.4 67 21 117 72.3 117 97.9" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="m554 266.2.1-1.4c4.1-36.4 8.2-71.7 27.1-103.4 6.5 4.4 5.7 10 3.7 15.2-19.9 51.2-18 104.4-16.2 157.6l.4 14c2.1 66.4-14.5 126.8-58.7 177.5-15.4 17.6-35.8 29.8-56.5 40.3-21.4 11-25.9 20.1-19.2 43.6l.8 2.6c1.4 3.9 2.8 7.9-1 11.8-4.5 4.6-9.5 3.3-14.8 1.8l-.6-.1a406.4 406.4 0 0 1-137-68.3c-6-4.4-10.8-10.3-15.5-16.1l-.3-.4c-2.5-3-3-7.8.5-10.4 3.3-2.5 5.8-.5 8.7 1.8l1 .9a145.5 145.5 0 0 0 76.3 31.7c13.4 1.4 26.6.9 40 .4 7.4-.3 14.8-.6 22.3-.5 10.2 0 18.7-4.7 26.7-9.2l2.8-1.6c27.8-15.5 54.3-32.8 72.2-60.7 16.1-25 25.9-52.2 31.6-80.9 7.2-36.1 6.6-72.7 6-109.8-.3-12-.5-24.2-.5-36.4ZM50.6 190.8c21.9-1.7 34 11.2 44.3 26.3a140.4 140.4 0 0 1 22.4 61.5c.5 3.7 1 7.6-1.2 11.3-4.5.6-4.9-3-5-5.6-.5-20.7-9.7-38.7-18.9-56.1-6.6-12.5-16.2-24.6-31.4-27.6-17.2-3.5-33 12-40.8 32.2-14.5 37.6-12 74.6 1.4 111 5.8 15.9 13.1 32.1 27.8 43.2 14.8 11.3 32.7 9.3 43.6-5.7l2-2.5c2-2.6 4-5.1 5-8 2.1-5.8 5.4-11.2 11.3-10.4 6.8 1 8 8.3 8.7 14a3661 3661 0 0 0 22 156.7l5.9 38.8c2.6 17.1 5.6 41.7 3.6 52.1a28 28 0 0 0-.3 2.2c-.4 2.8-.6 5-4.2 5.5-4.9.8-7-2-7.7-6.4-2.3-17-3-23.6-4-49.6-.9-25.2-5.6-50-10.4-74.9l-5-27c-5.2-30.8-10.3-62-10.8-97l-2 3c-7.6 11.3-13.7 20.5-24.5 24a40.5 40.5 0 0 1-46.1-12.5 127.8 127.8 0 0 1-28.8-55.8c-8.4-34-9.9-67.1.9-100.6 5.2-16.1 23.7-44.7 42.2-42Zm34.6 127.5c4.4 3.2 8.4 6 12-5.4-1.1-42.2-14.7-69.2-35.8-70.3 11.2 14.6 22 28.8 23 48.5a32.3 32.3 0 0 1-10.7-8.8c-2-2.2-4-4.4-6.5-6l-3-2.4c-4.8-3.6-9.7-7.4-17.8-4.5 3.8 5.8 9 10 14.3 14 6 4.7 12 9.3 15.6 16.5-10.6 7.7-15.2 17.7-9.7 29.9 4.8 10.5 11.9 19.2 25.9 19.8-.6-6.3-4.7-10.9-8.8-15.4-5-5.4-9.7-10.6-7.5-18.6 3.2-1.5 6.2.7 9 2.7Z" fill="#000"/></g><g transform="translate(178 1057)"><path d="M1304.4 692.5.7 689.2S34 479.5 96.9 360.3c73-138.7 173.6-266 400-320.3 9-2.1 96.1 44.3 128.4 60.3 15 7.4 77.1 2.9 77.1 2.9l110.8-54.9s130.4 42 196.6 79.3c84.2 47.3 179.2 187 223 296 46.6 115.8 71.6 269 71.6 269Z" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="M1280.6 615c5.5 25.8 11 51.7 17.5 77.5 4.6 0 8.1 0 11.3-.9a485 485 0 0 1-11.7-60.7c-2-13.1-4-26.2-6.6-39-6.2-30.4-13.2-60.5-22-90-10-33.6-21.4-67-35.3-99.3a734.6 734.6 0 0 0-48.2-97.8 834.7 834.7 0 0 0-89.3-119.8c-37.6-41.9-85.4-68.5-134.7-91.4a816 816 0 0 0-105.3-42.7c-25.6-7.8-52-12.4-79-12.2-6 0-9.3 3.6-5.5 7.6 8.2 8.6 2.4 11.8-3.3 14.9a101.8 101.8 0 0 0-8.9 5A203 203 0 0 1 731 81.2c-4.7 1.8-9.2 4.2-13.7 6.7-8.6 4.8-17.3 9.6-27.3 9.4-7-.1-13.9 0-20.8.3l-14.7.3c-7.2 0-14.3-1.2-21-3.8a247.8 247.8 0 0 1-37.6-18.9c-8.8-5-17.6-10.1-26.8-14.4l-11.6-5.3A298 298 0 0 1 503 26.1c-5.2-3.8-10.2-1.8-14.4.8-14.5 9-30.4 14.6-46.3 20.2-14 5-28 9.9-41 17-27.3 15-55.6 28.4-83.8 41.8-52.5 24.7-94.7 63.1-132.8 106.4-21 23.8-40 49.3-57 76.2a832.4 832.4 0 0 0-84 179l-1.2 3.5a703.8 703.8 0 0 0-20 65.8c-1.6 7.2-3.5 14.3-5.3 21.4-3 11.8-6 23.5-8.4 35.4-6.3 32.9-11.6 66-16.2 99 6.3 0 11.6 0 17.1-1.1 1.3-8.4 2.4-16.6 3.5-24.7 2.2-15.9 4.3-31.5 7.6-46.8l2.6-12.6c6.4-30.6 12.7-61.2 22.6-91 1-2.6 1.8-5.3 2.7-8 9.5-28.6 19-57.3 30.6-85.1a922.1 922.1 0 0 1 39.1-81.4 647.7 647.7 0 0 1 107-147.5c31.5-32.4 67.5-59 108.2-78.5 2.3-1 4.7-2.4 7-3.7 9.2-5.1 19-10.6 30-6.3 22.5 8.6 45 17.8 66.3 29 28.8 15 57.1 30.9 85.5 46.8 8.8 5 17.6 10 26.4 14.8l.5.3c19.8 11 19.8 11 32.4-7.6l.8-.3.5-.2c9.4 4 17.8 10 26.2 15.8 4.8 3.3 9.5 6.6 14.5 9.6 20.4 12.5 22.3 17.5 14.6 38.6-4.5 12.3-8.8 24.7-13.2 37-5.8 16.4-11.6 32.8-17.6 49a1075.7 1075.7 0 0 0-40 129.7c-5.2 22.2-.8 30.2 19.7 41 4.8 2.6 9.7 5 14.6 7.5l15.8 8.2c5.3 2.8 8.3 7 7.7 13.5-3.7 39.4-5 79-5.2 118.6 0 6.2-.7 12.4-1.4 18.6-.7 5.6-1.3 11.2-1.5 16.7h14.3c5.8-54.6 7.6-109.3 9.4-164.2.9-27.5 3-55 5-82.5 1.3-15.7 2.4-31.5 3.4-47.2.8-12 1-24.1 1.1-36.2.3-18.2.6-36.3 2.7-54.4 1.8-14.3 3.1-28.7 4.5-43.5l2-20.5c17 7 30.4.3 43.4-8 7.2 6 10.2 14 13 21.8l2.5 6.3c13.6 32.2 22.5 66 31 99.9 4.6 18 9 36 12.2 54.4l1.3 7.8v.4c6 34.9 12 69.8 16.2 105 3.7 32 5.8 64.3 8 96.5l2.3 35.5c.3 3.4.3 6.8.4 10.3.1 5.6.3 11.4 1.1 17.5 4.9 1.1 8.4 1.1 12.3 0 2.8-65.7-5-129.4-13.2-193.1l-1.7-12.6c-1-7.2-2-14.3-2.8-21.5a563 563 0 0 0-9.8-59c-2-8.8-4.5-17.6-7.1-26.4-3-9.9-5.8-19.8-7.9-30-3.7-18.8-10-36.7-16.3-54.6a322.5 322.5 0 0 0-28.3-62.2c-1.8-3-3.6-7.1.4-9 9.3-4 16.6-10.8 24-17.6 6.8-6.2 13.6-12.5 22-16.9l1.8 4.5c1.3 3 2.5 6 4 8.6 8.6 15.1 13 16 26.6 5.3 8.2-6.3 16.8-12 25.4-17.7 9.5-6.2 19-12.4 27.8-19.5 12-9.7 25.1-17.9 38.3-26a337 337 0 0 0 42.4-29.3c24-20.5 62 6.4 107.8 38.7l.6.5c43.4 30.6 76 72 106 115.2a791.5 791.5 0 0 1 55.8 96.5c16.7 33.2 31 67.5 42.6 102.7a1128.7 1128.7 0 0 1 39 147Zm-714-437c-2.2 3.9-4.2 6.2-8.8 4.3-22.7-10.9-44.4-23-66-35.2-34.7-19.6-69-38.9-106.3-51.6 0-5 2.4-6.2 4.5-7.2l.4-.1c13.1-6 25.8-12.9 38.1-20.5a42.4 42.4 0 0 1 22.9-6.9c20 0 40-.3 58-11 4.8-2.7 9.6-1.3 14.5 1.5l15.8 9.2c22 13 44.2 25.8 67.5 36.4 4.5 2 9 4.6 11.6 9.5a348.2 348.2 0 0 0-52.2 71.5Zm255.7-7.6c16-13.8 34-25 51.8-36.2 16-10 32-20 46.4-31.8-1.4-4.2-3.8-6-6.2-7.6a51 51 0 0 1-1.3-1C896.3 81 877 74 857.5 67c-6.5-2.4-13-4.7-19.4-7.3-9.2-3.7-20.4-7.7-31.9-1.3l-13.9 7.8a409 409 0 0 1-61.7 30.6c-6.6 2.4-7.4 5.6-3.2 11.4 4 5.5 7.7 11.1 11.4 16.8 4.5 6.6 8.9 13.2 13.6 19.6 8.2 11 16.7 22 25.2 32.7l10.8 13.8c11.5-6.8 22-13.1 33.9-20.6Zm-181.9-51.9c5.5-4.2 11.5-7.3 18.8-6.3 24.4-3.4 44 2 61.5 16.1 12 9.7 12.7 16.6 3.4 29-2.2 3-4 6.2-5.8 9.4-3 5.6-6 11-11.2 15-17.7-9.6-35.3-12-53.3-1.5-5.4 3.2-9.4 1.5-13.5-2.7a902 902 0 0 0-16.6-16.4l-7.8-7.6c-5.9-5.7-7.7-10.5 1-16 5.3-3.5 10-7.6 15-11.8 2.7-2.4 5.6-4.9 8.5-7.2Zm-24.3 389.3c3 1.7 6.3 3.4 11.2 3.4l2.3-57.7c2-50.4 4-100.7 7.8-151-4.7 10.1-8.4 20.5-12 30.8l-5.4 14.8c-16.1 42.3-28.5 85.8-39 129.7-1.6 6.5-1.4 12 5 15.3 7.9 4 15.8 8 25.5 12.6 1.6.5 3 1.3 4.6 2.1Zm58.5-321.3a27 27 0 0 1 16.3 1.6c13 12.7 14.7 22.7 6.6 32-11.1 13-28.1 16.9-39.4 9-8.6-6.1-10-15.4-7.3-24 3.4-11 13-16.5 23.8-18.6ZM633.1 204c10.3-1.3 5.3-8.7 2.8-11.1-9-8.8-18.3-17.1-28.4-26l-11.6-10.3c-.6 4.8-2.9 8-5 11.2a37.2 37.2 0 0 0-3.7 6l.2.2c15 10 29.7 19.6 45.7 30Zm94.5-25 4-4.8 2.7-4.6c2.6-4.5 4.8-8.3 8.4-11 12.5 12.3 12.5 16.8.5 26.2-1.2 1-2.4 1.8-3.7 2.7-2.8 2.1-5.7 4.2-8.1 6.8-3.6 3.7-7.1 7.2-12.7 9.2-5.3-4.4-4.7-8.8-.3-13.7 3.2-3.5 6.2-7.1 9.2-10.8Z" fill="#000"/><path d="M1113.7 692.5c-9.3-36.8-12.3-74.6-22.4-111-7.7-28-14-56.7-24-84-7.1-19.3-14-39-23.4-57.6-12.7-25-23.3-51.2-34.6-77-1.3-2.9-3-6.3 1.2-8.9 4.5-2.6 7.6-.4 10 2.8 4 5.4 8.5 10.8 11.3 16.8 9.4 20.3 19.2 40.5 28.9 60.6a612.4 612.4 0 0 1 34 95.6 617.4 617.4 0 0 1 21.8 96.4c2.7 21.4 7.2 42.7 8.8 65.3-3.4 1-7 1-11.6 1ZM210 692.5c1.5-7.9.6-16 .7-24a883 883 0 0 1 12.2-121.6c5.8-37.7 14-75 24.6-111.6A264 264 0 0 1 282 362c2-3 4.3-5.8 8.2-3.7 3.5 2 3.6 5.5 2.3 9-3.2 8-5.8 16-9.6 23.7-18.5 36.7-26.2 76.5-35 116.2-4.5 19.7-10.2 39.2-13.9 59.2a265.4 265.4 0 0 0-5.9 53c.5 24-5 47.4-3.7 72.2-4.5 1-8.8 1-14.3 1Z" fill="#000"/></g><g transform="translate(266 207)"><path d="m316.3 305 31.4-34.4c-12.2-11-21.7-26-17-45.4 4.6-19.4 18-30 37.4-33 1.4-29.5 9.3-37.5 38.8-37.5 9.3 0 10.7-4.8 11-11.8.8-32.3 22.3-48.4 48.7-58.7 31.1-12.2 73.7 5.1 91 34.7a85 85 0 0 1 12 37.2c.7 9.3 3.4 13.7 14.3 12 47-7.7 90.4 5.3 133.3 22.9 47.9 19.5 86 52.3 119.8 89.7 20.8 23 37.5 50.1 41.2 82.7 2.2 19-2 35.1-18.9 46.6-22 15.2-47.3 19.8-73 22.6-13.4 1.5-27.2-.3-40.8.4-34 1.8-65.1-9.5-97-18.4-30.8-8.6-60-20.4-87-37.4-2.3-1.5-5.6-1.4-7.8-2-6.9 5.5-4.2 13.3-6.9 19.5-13.2 31-38.5 48.7-66.5 63.7-14.2 7.6-29.1 13.9-43.3 21.4-19.2 10-28.8 29.4-35.7 49-3.8 11.1-8.5 22.2-9.5 34.3-.4 4.9-3.5 11.7-10.8 10.3-6-1.1-7-7-7-12.2.2-29.1-14.2-53-29.1-76-12.2-18.7-37.8-19.9-53 2.4-4.8 7.1-7 15.6-11 22.9-3.8 7-7.3 14-11 22-9.4-4.2-11.9-12-14-20.1-4.8-18.7-1.4-37.3 1-55.7A337.7 337.7 0 0 1 291 344c7-13.6 16.4-25.5 25.4-39Z" fill="#000"/></g><g transform="translate(791 871)"><g fill-rule="evenodd" clip-rule="evenodd"><path d="M141.4 72.2c-23-2.7-47.2-5.5-66.3 14.6-4 3.5-6.5 8.5-6.8 13.8-18.2-4.6-32-31.2-23.7-46.7 6.6-12.4 19.8-14.6 32.5-16.3 29-4 56.6 5 78.7 20.1 13.2 9.1 23.7 8.7 36 8.2h2.6l.8-.1c7-.3 14-.6 18.3 7 4.6 8.4 4.2 16.7-1.5 24-6.1 7.8-12.6 16-25 18.1-4-22.2-16-39.5-38.4-41.9l-7.2-.8Zm-19.7 33.7c-1.5-1.7-3-3.4-4.7-5-3.5-4-7.1-7.7-9.9-12-3.9-6.3-8.2-5.4-12.8-2.7-7 4.2-14.3 9-12.9 18.6 1 6 5.4 5.6 9.5 5.3 1 0 2-.2 3-.1h17.2c18-.4 35.9-.7 53 7 2.1 1 4.5.4 6-1.3-1.3-18.7-28-35.8-46.5-29.6 0 2 .8 4.3 1.7 6.4 1.9 4.6 3.7 9.2-3.6 13.4Z" fill="#fff"/><path d="M29.1 56c2.9-21.8 32-32.2 54.7-32.5 31.5-.5 61 9.1 87.7 26.1 5 3.4 11 4.5 16.8 3 19.4-4.3 32.8.4 38.1 11.8 10.4 22-.5 43.8-11.6 53.2-20.5 17-43.8 16.5-67.3 9.4a81.2 81.2 0 0 0-34.7-3c-32.1 4-59.2-5.9-76.6-34a49.7 49.7 0 0 1-7-34Zm46 30.8c19.1-20 43.3-17.3 66.3-14.6l7.2.8c22.4 2.4 34.5 19.7 38.5 42 12.3-2.3 18.8-10.4 25-18.3 5.6-7.2 6-15.5 1.4-23.8-4.2-7.7-11.3-7.4-18.3-7.1h-.8l-2.5.1c-12.4.5-22.9 1-36-8.2A112.4 112.4 0 0 0 77 37.6c-12.7 1.7-25.9 3.9-32.5 16.3-8.2 15.5 5.5 42.1 23.7 46.7.3-5.3 2.7-10.3 6.8-13.8Zm46.6 19-4.7-5c-3.5-3.8-7.1-7.6-9.9-12-3.9-6.2-8.2-5.3-12.8-2.6-7 4.2-14.3 9-12.9 18.6 1 6 5.4 5.6 9.5 5.3 1 0 2-.2 3-.1h17.2c18-.4 35.9-.7 53 7 2.1 1 4.5.4 6-1.3-1.3-18.7-28-35.8-46.5-29.6 0 2 .8 4.3 1.7 6.4 1.9 4.6 3.7 9.2-3.6 13.4Z" fill="#000"/></g></g><g transform="translate(653 805)"></g><g transform="translate(901 668)"><path d="M27 199.5c-7.6-4.6-16.3-6-19.8-14.5-1.8-4.5-3.5-9-1.4-13.5 3-6.4 8.9-8.5 15-6 8.6 3.7 1.8 9 .5 13.6C45 199 75 190.2 95.3 176c7.1-5 4.4-10.5-1.6-14.1-11.2-6.7-21.4-15.5-36.4-13.7 2.5-12.3 10.3-12.6 17-11.2A67.4 67.4 0 0 1 108 154c10.4 10.2 9.5 23.6-1.5 33.3-16 14.2-35.7 17.2-55.9 16-7.4-.3-15.4.3-23.5-3.7Z" fill="#000"/></g><g transform="translate(610 680)"><path d="M407.4 122.5c13 .3 25.4 1.1 37.6 2.5 3 .4 5 3.3 5 6.7 0 3.3-1.7 5.6-4.7 7-11.2 4.8-22 8.2-33.7.2-6.5-4.5-9-8.7-4.2-16.4ZM251.2 124c6.4 2.8 5.6 6.6 3 10.6-5.9 8.6-27.3 12.5-36 6.6-5-3.4-8-8-5.6-14 2.5-6.2 7.7-5.6 12.8-3.6 8.3 3.3 16.5 1.7 25.8.4ZM419.6 111c-4.2-9.5-9.9-15.2-19.8-15.7-6-.3-7-5.1-8.9-9.8 2-1.5 3.5-3.7 5.3-3.8 21.1-1.7 42.4-1.8 63.5-.1 6 .4 9.3 8 3.2 10.4-10 4-12.5 13.2-18.5 19.8-8.2 9-15.2 9.1-24.8-.8ZM229.6 81.1c12.2.7 23.1 1 34 2 3.6.3 8 1.8 8 6.7 0 5.6-4.6 5.2-8.3 5.1-6.3 0-9.7 2.7-12.5 8.6-3.4 7.4-6.9 15.3-18 14.8-10.5-.6-15.1-7.2-18.2-15.2-2-5.7-4.9-8.4-10.9-8.2-3.4.1-7.1-.2-7.5-4.9-.4-5 3-6 7-7.2a67.7 67.7 0 0 1 26.4-1.7Z" fill="#000"/></g><g transform="translate(610 680)"></g><g transform="translate(774 657)"><path d="M47.1 22c23.6-.3 45.4-8.9 68.1-5.8 18.2 2.5 36.3 4 54.6.9 6.6-1.2 11.6 2 13 12 1.5-13.5 13.4-12.8 17.1-11.2 15.5 6.6 30.2 1 44.9-.5 20-2 48.5 10.6 58.3 28.4a52 52 0 0 0 4.4 6.1c2.8 3.7 7.3 7.2 3 12.1-4.1 4.6-9.2 1.7-13-.3C289 59 280.8 53.7 273 48a18 18 0 0 0-19-2.4 76.4 76.4 0 0 1-38.9 4.4c-14.4-1.5-29.5 3.4-43 2-21.5-2.5-43.2 3.4-64.2-3.5-8.4-2.8-16.7-6.9-25.1.2-.9.7-2.7 1.3-3.6.9-12.3-6-24.4 0-36.4.1-10.2 0-20.2 3-30.3 1.6-3.8-.5-9.2 2-11-3.6-2-6.2 4-8.2 7.5-10.3C17.4 32.2 26 26.7 36.7 26c3.2-.2 6.3-2.4 10.4-4Z" fill="#000"/></g><g transform="translate(0 559)"></g></g></svg></div>
             <div class="agent-details">
                <div class="agent-role">Data Analyst</div>
                <div class="agent-name">Insights & Modeling</div>
             </div>
             <div class="thinking-dots"><span></span><span></span><span></span></div>
          </div>

          <!-- PULSE -->
          <div class="agent-card" id="agent-devops" data-agent-key="devops" draggable="true" style="--agent-color: #8b5cf6">
             <div class="agent-avatar" id="av_pulse"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1744 1744" fill="none" shape-rendering="auto"><metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:RDF><rdf:Description><dc:title>Notionists</dc:title><dc:creator>Zoish</dc:creator><dc:source xsi:type="dcterms:URI">https://heyzoish.gumroad.com/l/notionists</dc:source><dcterms:license xsi:type="dcterms:URI">https://creativecommons.org/publicdomain/zero/1.0/</dcterms:license><dc:rights>Remix of „Notionists” (https://heyzoish.gumroad.com/l/notionists) by „Zoish”, licensed under „CC0 1.0” (https://creativecommons.org/publicdomain/zero/1.0/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id="viewboxMask"><rect width="1744" height="1744" rx="0" ry="0" x="0" y="0" fill="#fff" /></mask><g mask="url(#viewboxMask)"><g transform="translate(531 487)"><path d="M554 727.7c-99.2 297-363.8 388.6-503.7 19.8-19.3-50.7 31-69.5 66.2-91.9 24.1-15.3 36.8-28.5 35.3-42.2-7-64.4-36.9-243.8-36.9-243.8l-3-5.8s.7-1.6-2.2 1.2c-3 3-9.9 34.2-37 34.2-24.5 0-49.2-10.9-61-86.3C7.2 285.6 9.6 214 40 201c12.5-5.3 24-7.2 35.2-.8 11.3 6.4-13-22 112-126C268.4 6.4 396.7-3.5 448.5 8 500.3 19.5 552 44.8 574.9 98.5c27.8 65-25.9 114.3-14 262.5-2.2 53.6.8 171.2-146.6 210.6-28 7.5-19.3 48.4 22.7 58.4 67 21 117 72.3 117 97.9" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="m554 266.2.1-1.4c4.1-36.4 8.2-71.7 27.1-103.4 6.5 4.4 5.7 10 3.7 15.2-19.9 51.2-18 104.4-16.2 157.6l.4 14c2.1 66.4-14.5 126.8-58.7 177.5-15.4 17.6-35.8 29.8-56.5 40.3-21.4 11-25.9 20.1-19.2 43.6l.8 2.6c1.4 3.9 2.8 7.9-1 11.8-4.5 4.6-9.5 3.3-14.8 1.8l-.6-.1a406.4 406.4 0 0 1-137-68.3c-6-4.4-10.8-10.3-15.5-16.1l-.3-.4c-2.5-3-3-7.8.5-10.4 3.3-2.5 5.8-.5 8.7 1.8l1 .9a145.5 145.5 0 0 0 76.3 31.7c13.4 1.4 26.6.9 40 .4 7.4-.3 14.8-.6 22.3-.5 10.2 0 18.7-4.7 26.7-9.2l2.8-1.6c27.8-15.5 54.3-32.8 72.2-60.7 16.1-25 25.9-52.2 31.6-80.9 7.2-36.1 6.6-72.7 6-109.8-.3-12-.5-24.2-.5-36.4ZM50.6 190.8c21.9-1.7 34 11.2 44.3 26.3a140.4 140.4 0 0 1 22.4 61.5c.5 3.7 1 7.6-1.2 11.3-4.5.6-4.9-3-5-5.6-.5-20.7-9.7-38.7-18.9-56.1-6.6-12.5-16.2-24.6-31.4-27.6-17.2-3.5-33 12-40.8 32.2-14.5 37.6-12 74.6 1.4 111 5.8 15.9 13.1 32.1 27.8 43.2 14.8 11.3 32.7 9.3 43.6-5.7l2-2.5c2-2.6 4-5.1 5-8 2.1-5.8 5.4-11.2 11.3-10.4 6.8 1 8 8.3 8.7 14a3661 3661 0 0 0 22 156.7l5.9 38.8c2.6 17.1 5.6 41.7 3.6 52.1a28 28 0 0 0-.3 2.2c-.4 2.8-.6 5-4.2 5.5-4.9.8-7-2-7.7-6.4-2.3-17-3-23.6-4-49.6-.9-25.2-5.6-50-10.4-74.9l-5-27c-5.2-30.8-10.3-62-10.8-97l-2 3c-7.6 11.3-13.7 20.5-24.5 24a40.5 40.5 0 0 1-46.1-12.5 127.8 127.8 0 0 1-28.8-55.8c-8.4-34-9.9-67.1.9-100.6 5.2-16.1 23.7-44.7 42.2-42Zm34.6 127.5c4.4 3.2 8.4 6 12-5.4-1.1-42.2-14.7-69.2-35.8-70.3 11.2 14.6 22 28.8 23 48.5a32.3 32.3 0 0 1-10.7-8.8c-2-2.2-4-4.4-6.5-6l-3-2.4c-4.8-3.6-9.7-7.4-17.8-4.5 3.8 5.8 9 10 14.3 14 6 4.7 12 9.3 15.6 16.5-10.6 7.7-15.2 17.7-9.7 29.9 4.8 10.5 11.9 19.2 25.9 19.8-.6-6.3-4.7-10.9-8.8-15.4-5-5.4-9.7-10.6-7.5-18.6 3.2-1.5 6.2.7 9 2.7Z" fill="#000"/></g><g transform="translate(178 1057)"><path d="M1304.4 692.5.7 689.2S34 479.5 96.9 360.3c73-138.7 173.6-266 400-320.3 9-2.1 96.1 44.3 128.4 60.3 15 7.4 77.1 2.9 77.1 2.9l110.8-54.9s130.4 42 196.6 79.3c84.2 47.3 179.2 187 223 296 46.6 115.8 71.6 269 71.6 269Z" fill="#fff"/><path d="M631.4 692.5s-1.8-127.4-.4-169.8c2-64.6 19.5-284 19.5-284s16.8 4.6 25.5 2.7a404 404 0 0 0 30.5-11.7s44.4 106.5 53.6 143.7c15.6 62.8 33.3 256.5 33.3 256.5l2.8 62.6H631.4Z" fill="#000"/><path fill-rule="evenodd" clip-rule="evenodd" d="M1280.6 615c5.5 25.8 11 51.7 17.5 77.5 4.6 0 8.1 0 11.3-.9a485 485 0 0 1-11.7-60.7c-2-13.1-4-26.2-6.6-39-6.2-30.4-13.2-60.5-22-90-10-33.6-21.4-67-35.3-99.3a734.6 734.6 0 0 0-48.2-97.8 834.7 834.7 0 0 0-89.3-119.8c-37.6-41.9-85.4-68.5-134.7-91.4a816 816 0 0 0-105.3-42.7c-25.6-7.8-52-12.4-79-12.2-6 0-9.3 3.6-5.5 7.6 8.2 8.6 2.4 11.8-3.3 14.9a101.8 101.8 0 0 0-8.9 5A203 203 0 0 1 731 81.2c-4.7 1.8-9.2 4.2-13.7 6.7-8.6 4.8-17.3 9.6-27.3 9.4-7-.1-13.9 0-20.8.3l-14.7.3c-7.2 0-14.3-1.2-21-3.8a247.8 247.8 0 0 1-37.6-18.9c-8.8-5-17.6-10.1-26.8-14.4l-11.6-5.3A298 298 0 0 1 503 26.1c-5.2-3.8-10.2-1.8-14.4.8-14.5 9-30.4 14.6-46.3 20.2-14 5-28 9.9-41 17-27.3 15-55.6 28.4-83.8 41.8-52.5 24.7-94.7 63.1-132.8 106.4-21 23.8-40 49.3-57 76.2a832.4 832.4 0 0 0-84 179l-1.2 3.5a703.8 703.8 0 0 0-20 65.8c-1.6 7.2-3.5 14.3-5.3 21.4-3 11.8-6 23.5-8.4 35.4-6.3 32.9-11.6 66-16.2 99 6.3 0 11.6 0 17.1-1.1 1.3-8.4 2.4-16.6 3.5-24.7 2.2-15.9 4.3-31.5 7.6-46.8l2.6-12.6c6.4-30.6 12.7-61.2 22.6-91 1-2.6 1.8-5.3 2.7-8 9.5-28.6 19-57.3 30.6-85.1a922.1 922.1 0 0 1 39.1-81.4 647.7 647.7 0 0 1 107-147.5c31.5-32.4 67.5-59 108.2-78.5 2.3-1 4.7-2.4 7-3.7 9.2-5.1 19-10.6 30-6.3 22.5 8.6 45 17.8 66.3 29 28.8 15 57.1 30.9 85.5 46.8 8.8 5 17.6 10 26.4 14.8l.5.3c19.8 11 19.8 11 32.4-7.6l.8-.3.5-.2c9.4 4 17.8 10 26.2 15.8 4.8 3.3 9.5 6.6 14.5 9.6 20.4 12.5 22.3 17.5 14.6 38.6-4.5 12.3-8.8 24.7-13.2 37-5.8 16.4-11.6 32.8-17.6 49a1075.7 1075.7 0 0 0-40 129.7c-5.2 22.2-.8 30.2 19.7 41 4.8 2.6 9.7 5 14.6 7.5l15.8 8.2c5.3 2.8 8.3 7 7.7 13.5-3.7 39.4-5 79-5.2 118.6 0 6.2-.7 12.4-1.4 18.6-.7 5.6-1.3 11.2-1.5 16.7h14.3c5.8-54.6 7.6-109.3 9.4-164.2.9-27.5 3-55 5-82.5 1.3-15.7 2.4-31.5 3.4-47.2.8-12 1-24.1 1.1-36.2.3-18.2.6-36.3 2.7-54.4 1.8-14.3 3.1-28.7 4.5-43.5l2-20.5c17 7 30.4.3 43.4-8 7.2 6 10.2 14 13 21.8l2.5 6.3c13.6 32.2 22.5 66 31 99.9 4.6 18 9 36 12.2 54.4l1.3 7.8v.4c6 34.9 12 69.8 16.2 105 3.7 32 5.8 64.3 8 96.5l2.3 35.5c.3 3.4.3 6.8.4 10.3.1 5.6.3 11.4 1.1 17.5 4.9 1.1 8.4 1.1 12.3 0 2.8-65.7-5-129.4-13.2-193.1l-1.7-12.6c-1-7.2-2-14.3-2.8-21.5a563 563 0 0 0-9.8-59c-2-8.8-4.5-17.6-7.1-26.4-3-9.9-5.8-19.8-7.9-30-3.7-18.8-10-36.7-16.3-54.6a322.5 322.5 0 0 0-28.3-62.2c-1.8-3-3.6-7.1.4-9 9.3-4 16.6-10.8 24-17.6 6.8-6.2 13.6-12.5 22-16.9l1.8 4.5c1.3 3 2.5 6 4 8.6 8.6 15.1 13 16 26.6 5.3 8.2-6.3 16.8-12 25.4-17.7 9.5-6.2 19-12.4 27.8-19.5 12-9.7 25.1-17.9 38.3-26a337 337 0 0 0 42.4-29.3c24-20.5 62 6.4 107.8 38.7l.6.5c43.4 30.6 76 72 106 115.2a791.5 791.5 0 0 1 55.8 96.5c16.7 33.2 31 67.5 42.6 102.7a1128.7 1128.7 0 0 1 39 147Zm-714-437c-2.2 3.9-4.2 6.2-8.8 4.3-22.7-10.9-44.4-23-66-35.2-34.7-19.6-69-38.9-106.3-51.6 0-5 2.4-6.2 4.5-7.2l.4-.1c13.1-6 25.8-12.9 38.1-20.5a42.4 42.4 0 0 1 22.9-6.9c20 0 40-.3 58-11 4.8-2.7 9.6-1.3 14.5 1.5l15.8 9.2c22 13 44.2 25.8 67.5 36.4 4.5 2 9 4.6 11.6 9.5a348.2 348.2 0 0 0-52.2 71.5Zm255.7-7.6c16-13.8 34-25 51.8-36.2 16-10 32-20 46.4-31.8-1.4-4.2-3.8-6-6.2-7.6a51 51 0 0 1-1.3-1C896.3 81 877 74 857.5 67c-6.5-2.4-13-4.7-19.4-7.3-9.2-3.7-20.4-7.7-31.9-1.3l-13.9 7.8a409 409 0 0 1-61.7 30.6c-6.6 2.4-7.4 5.6-3.2 11.4 4 5.5 7.7 11.1 11.4 16.8 4.5 6.6 8.9 13.2 13.6 19.6 8.2 11 16.7 22 25.2 32.7l10.8 13.8c11.5-6.8 22-13.1 33.9-20.6Zm-181.9-51.9c5.5-4.2 11.5-7.3 18.8-6.3 24.4-3.4 44 2 61.5 16.1 12 9.7 12.7 16.6 3.4 29-2.2 3-4 6.2-5.8 9.4-3 5.6-6 11-11.2 15-17.7-9.6-35.3-12-53.3-1.5-5.4 3.2-9.4 1.5-13.5-2.7a902 902 0 0 0-16.6-16.4l-7.8-7.6c-5.9-5.7-7.7-10.5 1-16 5.3-3.5 10-7.6 15-11.8 2.7-2.4 5.6-4.9 8.5-7.2Zm-24.3 389.3c3 1.7 6.3 3.4 11.2 3.4l2.3-57.7c2-50.4 4-100.7 7.8-151-4.7 10.1-8.4 20.5-12 30.8l-5.4 14.8c-16.1 42.3-28.5 85.8-39 129.7-1.6 6.5-1.4 12 5 15.3 7.9 4 15.8 8 25.5 12.6 1.6.5 3 1.3 4.6 2.1Zm58.5-321.3a27 27 0 0 1 16.3 1.6c13 12.7 14.7 22.7 6.6 32-11.1 13-28.1 16.9-39.4 9-8.6-6.1-10-15.4-7.3-24 3.4-11 13-16.5 23.8-18.6ZM633.1 204c10.3-1.3 5.3-8.7 2.8-11.1-9-8.8-18.3-17.1-28.4-26l-11.6-10.3c-.6 4.8-2.9 8-5 11.2a37.2 37.2 0 0 0-3.7 6l.2.2c15 10 29.7 19.6 45.7 30Zm94.5-25 4-4.8 2.7-4.6c2.6-4.5 4.8-8.3 8.4-11 12.5 12.3 12.5 16.8.5 26.2-1.2 1-2.4 1.8-3.7 2.7-2.8 2.1-5.7 4.2-8.1 6.8-3.6 3.7-7.1 7.2-12.7 9.2-5.3-4.4-4.7-8.8-.3-13.7 3.2-3.5 6.2-7.1 9.2-10.8Z" fill="#000"/><path d="M1113.7 692.5c-9.3-36.8-12.3-74.6-22.4-111-7.7-28-14-56.7-24-84-7.1-19.3-14-39-23.4-57.6-12.7-25-23.3-51.2-34.6-77-1.3-2.9-3-6.3 1.2-8.9 4.5-2.6 7.6-.4 10 2.8 4 5.4 8.5 10.8 11.3 16.8 9.4 20.3 19.2 40.5 28.9 60.6a612.4 612.4 0 0 1 34 95.6 617.4 617.4 0 0 1 21.8 96.4c2.7 21.4 7.2 42.7 8.8 65.3-3.4 1-7 1-11.6 1ZM210 692.5c1.5-7.9.6-16 .7-24a883 883 0 0 1 12.2-121.6c5.8-37.7 14-75 24.6-111.6A264 264 0 0 1 282 362c2-3 4.3-5.8 8.2-3.7 3.5 2 3.6 5.5 2.3 9-3.2 8-5.8 16-9.6 23.7-18.5 36.7-26.2 76.5-35 116.2-4.5 19.7-10.2 39.2-13.9 59.2a265.4 265.4 0 0 0-5.9 53c.5 24-5 47.4-3.7 72.2-4.5 1-8.8 1-14.3 1Z" fill="#000"/></g><g transform="translate(266 207)"><path d="M572.8 193.4c27-2.9 53.2-.9 79.4-2.1 10.2-.5 11-8 11.9-15.1 2.6-20 7-37.9 19.4-55.8 12.8-18.7 28.5-35 40.5-54 3.6-5.7 9.3-5.5 14.1-7.6 15-6.6 27-20.9 46-17.5 5.2.9 7.5-7.6 13.6-8.6a211 211 0 0 1 50.3-2.5c8.4.6 16.8-1 25.8.9 26 5.5 46.4 21.8 69.8 31.7 24 10 28.7 32.8 42.1 49.7 6.2 7.7 10.3 17.2 15.6 25.6 2 3.1 3.3 6.5 2.4 9.7-3.4 12.7 1.5 25.2.3 37.8-.5 6-.2 11.9 5 16.4 2.2 2 4.2 5.7 2.7 8-8.4 13.4-6 29.6-12.4 43.4-1.3 2.6-3.5 5.4-3.4 8 .3 18.3-12.7 29.5-22.3 42.3-6.3 8.3-14.3 15.4-18 25.6-2.6 6.7-10 8-15.3 10.7-19.4 9.9-35.4 25.8-58.4 29.3-10.6 1.7-21.1.2-19.7 10.5 4.6 34.1-24.5 108.6-24.5 108.7-3.5 5.8-13.4 2.8-11.9-3.8 8.5-37.2 2-53.4-.4-65.7a72.9 72.9 0 0 0-29-46.3 19.5 19.5 0 0 1-6-7c-5.4-10.9-13.7-15.7-25.5-20.9-14.6-6.4-28-15.2-39.7-26-14.9-14.2-18.6-.9-30-19.5-18.7-30.6-62-.8-62.6 3.4-2.8 22.7-46-27.4-76 18.2-4.5 6.8-9.4 11-17.5 13.3a28 28 0 0 0-18.6 20.1c-3 12.2-9.2 17.8-21.4 16.2-7.3-.9-12 3-14.2 8.4a28.2 28.2 0 0 1-18.7 17.6 18.5 18.5 0 0 0-9.1 6.7c-9.4 14.2-26.5 18.9-37.5 31.1-3.9 4.4-10 4.3-15.6 4.1-9.8-.3-13 3.2-12.6 13.7.4 11.2 5 24.5-4.7 30-1.7 31.2 1.9 59.8-5.9 88-6.8-.5-6.9-6-7.4-9.5-3.2-19.7-12.8-37.2-19.5-55.7a35.5 35.5 0 0 0-19.8-22c-9.6-3.9-17-9-13.5-22 2.2-8.5-7.7-15.8-18.4-13.4-9.7 2.2-17-.7-25-5.4-11.3-6.5-24.5-8.7-36-14.4-10.5-5.2-19.9-13.9-28.2-22.6-14-14.6-28.2-29.5-39.3-46.3a73.2 73.2 0 0 1-10.3-36.1c-.7-20-6-40.5-.5-60.3 5-18.3 8.3-36.9 11.4-55.6.6-2.9 2.3-5.5 4.8-7a33 33 0 0 0 14.6-17.4c8.2-21.5 28-30.1 44.4-42.7 7.9-6 14.6-13.2 23.2-18.7 7.9-5 12.7-11.5 24.3-8 6.6 2 14.7-3.7 23.6-3.8 22.2-.3 42.3 13.4 64.7 7.9 10.3-2.6 17.8 5.1 26.1 8.3 23.2 8.8 46.7 17.3 57.7 44 6.4 15.3 21.4 25.5 33.2 37.3 2.3 2.3 5.5 3.5 8.2 1.8 20.8-13.3 45.5-8 67.8-14.5 2-.4 3.9-.6 5.9-.6Z" fill="#000"/></g><g transform="translate(791 871)"><path d="M79.1 76.2c7.7-15.2-6-20-13-28.8-12 28.2-9.2 55.9 6.1 65 1.2-11.6-.3-23.8 7-36.2Z" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="M88.8 107v-9.7c1-2 1.5-4.2 1.9-6.2.7-3.4 1.3-6.5 4.3-8.8 4.5-.1 8.3 1.9 12.1 4 3.3 1.6 6.6 3.4 10.3 3.8h1c3 .5 6.3.9 7.8-3 1.6-4.1.2-7.7-3.8-9.5C103.6 69 91.2 53.7 78.9 38c-8.4-10.9-20.8-8.3-28.4 3.9-11.2 18-8.4 37.6-5.8 56l.1 1c2 13.6 9.3 27.7 24.9 33.3 11.4 4 18.4-.2 19-12.2l.1-13ZM72.2 53.5c6.5 5.8 12.6 11.3 7 22.7-5.5 9.4-6 18.7-6.4 27.7a152 152 0 0 1-.6 8.5c-15.3-9.1-18.2-36.8-6.1-65 1.8 2.2 4 4.2 6.1 6.1Z" fill="#000"/></g><g transform="translate(653 805)"></g><g transform="translate(901 668)"><path d="M69.4 96c-.6-14.1-4.3-27.2.4-40.1 1.2-3.3 1.2-8.6 6.7-8 5.5.8 4.5 5.6 4 9.2-4.6 30.7 7 58.6 15 87 2.7 9.3 6.6 18.2 6.1 28.4-.8 16.4-11.3 26.4-27.4 23.6a29.5 29.5 0 0 0-17.2 1.8c-14 5.6-26-5-39.6-5.3-4 0-6.6-7.3-7-12.7 0-2.5.4-5.2 3.5-6 2-.8 4.4.2 5.3 2.2 3.6 7 9.3 3.2 14.4 4.2 11.9 2 23 1.3 34.8.9 5.8-.3 11.7 3.3 17.2-1.7 5.8-5.2 4-11.3 2.2-17.6C81.7 140.3 72 119.7 69.4 96Z" fill="#000"/></g><g transform="translate(610 680)"><path d="M407.4 122.5c13 .3 25.4 1.1 37.6 2.5 3 .4 5 3.3 5 6.7 0 3.3-1.7 5.6-4.7 7-11.2 4.8-22 8.2-33.7.2-6.5-4.5-9-8.7-4.2-16.4ZM247.6 117c7 0 7.8 3.8 7 8.5-2 10.2-20 22.4-30.4 20.5-5.9-1-10.5-4-10.7-10.5-.2-6.7 4.8-8.2 10.3-8.4 9-.3 15.8-5.2 23.8-10ZM215.1 76.6c5-12 9-29.4 24.1-22.5 20.7 9.4 13.9 30.7 9.7 47.4-1.6 6.3-14.5 15.9-18.3 14.3-16.3-6.8-19.2-21.7-15.5-39.2ZM442 113.4c-8.6 7.5-17 7.6-22.2-1.5-9-16-8.6-32.8 3.3-47.2 2.5-3 13.8-3.6 16.3-1 14 15 14.6 31.8 2.6 49.7Z" fill="#000"/></g><g transform="translate(610 680)"><g fill="#000"><path fill-rule="evenodd" clip-rule="evenodd" d="m264.3 14.3 78.4-.5 125.6-.8 6.2-.2c7.2-.4 14.6-.7 21 2.4 10.1 5 10.7 15 11.3 24.4a172.3 172.3 0 0 1-8.8 79.6 50.5 50.5 0 0 1-32 30.5c-23.5 7.8-48 13.5-72 4.8a65.7 65.7 0 0 1-42.1-39c-1.2-3.2-2.7-6.4-4.1-9.5a58.9 58.9 0 0 1-7-23.5c-.2-4.7-5.7-8.1-11.7-8.1-7 0-10.7 4.5-13.6 9.9a56.8 56.8 0 0 0-4.6 14.3c-.8 3.6-1.7 7.3-3 10.8-14.2 37-38.8 55.3-78.1 54.5a100.6 100.6 0 0 1-66.7-27.4A61.5 61.5 0 0 1 142.2 87a311.6 311.6 0 0 0 0-12 399 399 0 0 1-59.6-20.4C64.2 47 45.8 39.8 26.6 35c-3.3-.8-5.5-2-6.8-4.9-4-8.3-9.6-15.5-16.6-24.5L.3 2.1l18.9 3.3C32 7.7 43.9 9.8 55.9 11.7c9.8 1.6 19.7 3.4 29.5 5.2 20.1 3.7 40.2 7.4 60.7 8.9 6.6.4 12.5.3 18.2-5.9 6.2-6.8 16.3-6.3 25-6l2.8.2c23.7.8 47.3 1 72.2.2ZM96.1 51.7c2.8 1.5 5.2 1.1 5.2-2.4 0-18.9-14.5-29-34.1-23.5 4 14 14.6 20.5 28.9 26Zm16 3.6c-2-1.5-3-4.2-5.6-11.3-3.5-6-5-10.6-3.7-18a38.7 38.7 0 0 1 11.4 21c1 3.5 2 7 3.6 10.2-2.7-.6-4.4-1-5.7-2Z"/><path d="M287 44.8c-.8-6 3-7.4 7-7.4 19 0 38 0 57.1.5 4.4 0 8.5 2 11.1 5.5-6.9 8.1-53.6 9.4-75.3 1.4Z"/></g></g><g transform="translate(774 657)"><path d="M56.8 30.9c9.5-10.6 21.8-16.2 31.6-25C93 1.8 98 3 101.8 7.5c3.8 4.3 7.3 8.3 2.7 14.5a83 83 0 0 1-42.7 28.3C47.4 55 32 56.5 17 59.3c-4.5.9-10.2 3.3-11.5-3.6-1.2-6.6 3.2-10 9.5-11.2 14.2-2.8 28.4-5.2 41.8-13.6ZM289.9 29c11.3 2 18 11 27.8 14.2 3.8 1.2 8.4 4.7 6.6 9.5-2.1 5.8-8 4.3-12.2 3a450.2 450.2 0 0 1-39.2-14.5c-12.8-5.6-25.1-12.4-37.4-19-6-3.2-11.6-7.8-7.4-15.2 4.2-7.3 11-9.5 18.3-3.7C259.4 13.8 275 19.8 290 29Z" fill="#000"/></g><g transform="translate(0 559)"></g></g></svg></div>
             <div class="agent-details">
                <div class="agent-role">DevOps</div>
                <div class="agent-name">Deployment & Scale</div>
             </div>
             <div class="thinking-dots"><span></span><span></span><span></span></div>
          </div>
        </div>

        <div class="dispatch-box" style="border: none; background: transparent; padding: 0; min-height: auto;">
          <div class="dispatch-label" style="justify-content: flex-end; width: 100%;">
            <span id="active-agent-label" style="color:var(--strata-accent); font-weight:700; text-transform:uppercase; font-size:10px; letter-spacing:0.1em; margin-right: 8px;">Waiting...</span>
          </div>
        </div>
      </section>

      <!-- 3. CHATBOX -->
      <section class="panel panel-bottom">
        <div class="panel-title-row">
          <div class="panel-title">Chat</div>
          <div class="chat-header-actions">
            <button class="chat-header-btn" id="chat-new-btn" title="New chat">+</button>
            <button class="chat-header-btn" id="chat-history-btn" title="History">History</button>
            <button class="chat-header-btn" id="chat-delete-btn" title="Delete current chat" style="color: #ef4444;">Delete</button>
          </div>
        </div>
        <div class="chat-history-popover" id="chat-history-popover"></div>
        <div class="chat-root">
          <div class="chat-messages" id="chat-messages"></div>
          <div class="chat-input-row">
            <div class="chat-input-shell">
              <textarea id="chat-input" class="chat-input-field" placeholder="Ask anything (Ctrl+L)" rows="1"></textarea>
              <div class="chat-input-meta">
                <button class="chat-icon-btn" id="chat-attach-btn" title="Attach file">+</button>
                <span class="chat-input-mode">
                  <span>&lt;/&gt;</span>
                  <span>Code</span>
                </span>
                <span class="chat-input-model">Gemini 3 Pro (high reasoning)</span>
                <span class="chat-attachment-label" id="chat-attachment-label"></span>
                <span class="upload-status" id="upload-status"><span class="upload-spinner"></span><span id="upload-status-text"></span></span>
              </div>
            </div>
            <button class="chat-icon-btn" id="chat-mic-btn" title="Voice">
              <img src="${microphoneSrc}" alt="Mic" class="voice-icon-img" />
            </button>
            <button class="chat-send-btn" id="chat-send-btn" title="Send">
              <img src="${sendSrc}" alt="Send" class="chat-send-icon" />
              <div class="chat-stop-icon"></div>
            </button>
          </div>
        </div>
      </section>

    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // No-op music handler so inline onclick does not throw and break the script
    function playMusic(el) {
      return;
    }

    // --- VOICE UI (local-only) ---
    const voiceMainBtn = document.getElementById('voice-main-btn');
    const voiceStatusPill = document.getElementById('voice-status-pill');
    const voiceParticipantsEl = document.getElementById('voice-participants');

    const voiceIcons = {
      microphone: '${microphoneSrc}',
      logout: '${logoutSrc}',
      robot: '${robotSrc}',
      user: '${userSrc}',
    };

    const voiceState = {
      connected: false,
      participants: [],
    };

    let activeAgentKey = null;

    const agentProfiles = {
      architect: { key: 'architect', name: 'Ari', role: 'Architect', color: '#a855f7', rate: 0.98, pitch: 0.95, voiceLike: 'en' },
      researcher: { key: 'researcher', name: 'Nova', role: 'Researcher', color: '#22c55e', rate: 1.02, pitch: 1.08, voiceLike: 'en' },
      coder: { key: 'coder', name: 'Byte', role: 'Coder', color: '#3b82f6', rate: 1.06, pitch: 1.02, voiceLike: 'en' },
      debugger: { key: 'debugger', name: 'Patch', role: 'Debugger', color: '#ef4444', rate: 0.98, pitch: 0.9, voiceLike: 'en' },
      data: { key: 'data', name: 'Quill', role: 'Data Collector', color: '#f59e0b', rate: 0.98, pitch: 1.0, voiceLike: 'en' },
      devops: { key: 'devops', name: 'Pulse', role: 'DevOps', color: '#8b5cf6', rate: 0.96, pitch: 0.92, voiceLike: 'en' },
    };

    function pickSpeechVoice(voiceLike) {
      try {
        const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
        if (!Array.isArray(voices) || voices.length === 0) return null;
        const needle = String(voiceLike || '').toLowerCase();
        const exact = voices.find((v) => String(v.lang || '').toLowerCase().startsWith(needle));
        return exact || voices[0] || null;
      } catch {
        return null;
      }
    }

    function speak(text, profile) {
      if (!text || !window.speechSynthesis) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(String(text));
        const p = profile && typeof profile === 'object' ? profile : {};
        const v = pickSpeechVoice(p.voiceLike);
        if (v) u.voice = v;
        u.rate = typeof p.rate === 'number' ? p.rate : 1.0;
        u.pitch = typeof p.pitch === 'number' ? p.pitch : 1.0;
        u.volume = 1.0;
        window.speechSynthesis.speak(u);
      } catch {
        // ignore
      }
    }

    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => {
          try { window.speechSynthesis.getVoices(); } catch { /* ignore */ }
        };
      } catch {
        // ignore
      }
    }

    function greet(profile) {
      const p = profile && typeof profile === 'object' ? profile : null;
      if (!p) return;
      const lines = [
        'Hey. ' + p.name + ' here — ' + p.role + '.',
        'Hi — I’m ' + p.name + '. Want me to take this one?',
        'Yo. ' + p.name + '. I’ll keep it clean and quick.',
        'Hello — ' + p.name + '. Let’s make this painless.',
      ];
      const text = lines[Math.floor(Math.random() * lines.length)];
      speak(text, p);
    }

    function applyAgentToVoiceRoom(agentKey) {
      const p = agentKey && agentProfiles[agentKey] ? agentProfiles[agentKey] : null;
      if (!p) return;
      if (!voiceState.connected) return;
      const me = voiceState.participants.find((x) => x && x.id === 'me');
      const newAgent = { id: 'agent', name: p.name, role: p.role, muted: false, isMe: false, canLeave: false, avatar: voiceIcons.robot, accent: p.color };
      voiceState.participants = [
        me || { id: 'me', name: 'You', role: 'Human', muted: false, isMe: true, canLeave: true, avatar: voiceIcons.user },
        newAgent,
      ];
      renderVoiceParticipants();
    }

    function setActiveAgent(agentKey, options) {
      const opts = options && typeof options === 'object' ? options : {};
      
      // Update internal state
      activeAgentKey = agentKey; 
      vscode.postMessage({ type: 'activeAgentChanged', agentKey: activeAgentKey || '' });

      // Handle Voice Room Join (Dynamic)
      // Check both 'agents' (from drag/drop) and 'agentProfiles' (internal)
      const agentData = (agents && agents[agentKey]) ? agents[agentKey] : (agentProfiles && agentProfiles[agentKey] ? agentProfiles[agentKey] : null);

      if (voiceState.connected && agentData) {
        const idToCheck = agentData.id || ('agent-' + agentKey);
        const existing = voiceState.participants.find(p => p.id === idToCheck);
        
        if (!existing) {
             // Determine props based on source object structure
             const name = agentData.label ? agentData.label.split('(')[0].trim() : (agentData.name || 'Agent');
             const role = agentData.label ? agentData.label.split('(')[1].replace(')', '') : (agentData.role || 'AI');
             // Try to get color var
             let accent = '';
             try {
                accent = getComputedStyle(document.documentElement).getPropertyValue('--agent-' + agentKey.replace('agent-', ''));
             } catch(e) {}

             voiceState.participants.push({
               id: idToCheck, 
               name: name,
               role: role,
               muted: false, 
               isMe: false, 
               canLeave: false, 
               avatar: voiceIcons.robot, // Default robot icon
               accent: accent
             });
             renderVoiceParticipants();
             
             // Announce & Effect
             const label = agentData.label || agentData.name || 'Agent';
             speak(label + ' joined the room.');
             triggerAppleEffect();

             // Signal parent window (App/IDE) for full-screen effect
             try {
                 window.top.postMessage({ type: 'strata-agent-active', active: true }, '*');
             } catch(e) { /* ignore cross-origin if blocked */ }
        }
      }


      if (opts.greet) {
        // We might not have 'greet' function on 'agents' objects, so skip if not in profiles
        // or just rely on the speak above.
      }
    }

    // Border Effect Logic
    // Border Effect Logic
    function triggerAppleEffect() {
        // Play sound (Keep sound as feedback)
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.05, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.0);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 2.0);
        } catch(e) { /* ignore audio error */ }

        // Signal parent window (App/IDE) for full-screen effect
        try {
             window.top.postMessage({ type: 'strata-agent-active', active: true }, '*');
        } catch(e) { /* ignore */ }
    }

    function updateVoiceStatus() {
      if (!voiceStatusPill || !voiceMainBtn) return;
      if (voiceState.connected) {
        voiceStatusPill.textContent = 'Connected';
        voiceStatusPill.classList.remove('voice-status-off');
        voiceStatusPill.classList.add('voice-status-on');
        voiceMainBtn.textContent = 'Leave voice';
      } else {
        voiceStatusPill.textContent = 'Disconnected';
        voiceStatusPill.classList.remove('voice-status-on');
        voiceStatusPill.classList.add('voice-status-off');
        voiceMainBtn.textContent = 'Join voice';
      }
    }

    function renderVoiceParticipants() {
      if (!voiceParticipantsEl) return;
      voiceParticipantsEl.innerHTML = '';

      if (!voiceState.connected || voiceState.participants.length === 0) {
        const empty = document.createElement('div');
        empty.style.fontSize = '11px';
        empty.style.color = 'var(--strata-text-muted)';
        empty.textContent = 'No one in voice. Join to start.';
        voiceParticipantsEl.appendChild(empty);
        return;
      }

      voiceState.participants.forEach((p) => {
        const card = document.createElement('div');
        card.className = 'voice-card' + (p.isMe ? ' me' : '') + (p.muted ? ' muted' : '');
        card.dataset.id = p.id;

        if (p && p.accent) {
          card.style.borderColor = p.accent;
        }

        const left = document.createElement('div');
        left.className = 'voice-left';

        const avatar = document.createElement('div');
        avatar.className = 'voice-avatar';
        if (p && p.accent) {
          avatar.style.background = 'radial-gradient(circle at top, ' + p.accent + ', transparent 70%)';
        }
        const img = document.createElement('img');
        img.className = 'voice-avatar-img';
        img.src = p.avatar;
        img.alt = p.role;
        avatar.appendChild(img);

        const text = document.createElement('div');
        text.className = 'voice-text';
        const nameEl = document.createElement('div');
        nameEl.className = 'voice-name';
        nameEl.textContent = p.name;
        const roleEl = document.createElement('div');
        roleEl.className = 'voice-role';
        roleEl.textContent = p.role;
        text.appendChild(nameEl);
        text.appendChild(roleEl);

        left.appendChild(avatar);
        left.appendChild(text);

        const actions = document.createElement('div');
        actions.className = 'voice-actions';

        const micBtn = document.createElement('button');
        micBtn.className = 'voice-icon-btn';
        micBtn.dataset.action = 'toggle-mic';
        micBtn.dataset.id = p.id;
        micBtn.setAttribute('data-label', p.muted ? 'Unmute' : 'Mute');
        const micImg = document.createElement('img');
        micImg.className = 'voice-icon-img';
        micImg.src = voiceIcons.microphone;
        micImg.alt = 'Mic';
        micBtn.appendChild(micImg);
        actions.appendChild(micBtn);

        if (p.canLeave) {
          const leaveBtn = document.createElement('button');
          leaveBtn.className = 'voice-icon-btn';
          leaveBtn.dataset.action = 'leave-self';
          leaveBtn.dataset.id = p.id;
          leaveBtn.setAttribute('data-label', 'Leave voice');
          const leaveImg = document.createElement('img');
          leaveImg.className = 'voice-icon-img';
          leaveImg.src = voiceIcons.logout;
          leaveImg.alt = 'Leave';
          leaveBtn.appendChild(leaveImg);
          actions.appendChild(leaveBtn);
        } else if (!p.isMe) {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'voice-icon-btn';
          removeBtn.dataset.action = 'remove-agent';
          removeBtn.dataset.id = p.id;
          removeBtn.setAttribute('data-label', 'Remove agent');
          const removeImg = document.createElement('img');
          removeImg.className = 'voice-icon-img';
          removeImg.src = voiceIcons.logout;
          removeImg.alt = 'Remove';
          removeBtn.appendChild(removeImg);
          actions.appendChild(removeBtn);
        }

        card.appendChild(left);
        card.appendChild(actions);
        voiceParticipantsEl.appendChild(card);
      });
    }

    let recognition = null;

    function setupSpeechRecognition() {
      if (recognition) return;
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        console.warn('SpeechRecognition not supported in this environment.');
        return;
      }
      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        const last = event.results.length - 1;
        const text = event.results[last][0].transcript.trim();
        if (text) {
           // User spoke -> simulate chat input
           if (chatInput && typeof sendChat === 'function') {
             chatInput.value = text;
             sendChat();
           }
        }
      };

      recognition.onerror = (event) => {
        console.warn('Speech recognition error', event.error);
      };
    }

    function joinVoice() {
      if (voiceState.connected) return;
      voiceState.connected = true;
      // ONLY add the user initially - no dummy agents
      voiceState.participants = [
        { id: 'me', name: 'You', role: 'Human', muted: false, isMe: true, canLeave: true, avatar: voiceIcons.user },
      ];
      updateVoiceStatus();
      renderVoiceParticipants();
      
      // Start listening
      setupSpeechRecognition();
      if (recognition) {
        try { recognition.start(); } catch (e) { /* ignore if already started */ }
      }
    }

    function leaveVoice() {
      voiceState.connected = false;
      voiceState.participants = [];
      updateVoiceStatus();
      renderVoiceParticipants();
      
      // Stop listening
      if (recognition) {
        try { recognition.stop(); } catch (e) { /* ignore */ }
      }
    }

    if (voiceMainBtn) {
      voiceMainBtn.addEventListener('click', () => {
        if (!voiceState.connected) {
          joinVoice();
        } else {
          leaveVoice();
        }
      });
    }

    if (voiceParticipantsEl) {
      voiceParticipantsEl.addEventListener('click', (event) => {
        const target = event.target.closest('.voice-icon-btn');
        if (!target) return;
        const action = target.dataset.action;
        const id = target.dataset.id;
        if (action === 'toggle-mic') {
          const p = voiceState.participants.find((x) => x.id === id);
          if (!p) return;
          p.muted = !p.muted;
          renderVoiceParticipants();
        } else if (action === 'leave-self') {
          const p = voiceState.participants.find((x) => x.id === id);
          if (!p || !p.canLeave) return;
          leaveVoice();
        } else if (action === 'remove-agent') {
          voiceState.participants = voiceState.participants.filter((x) => x.id !== id);
          renderVoiceParticipants();
          
          if (activeAgentKey) {
            activeAgentKey = null;
            vscode.postMessage({ type: 'activeAgentChanged', agentKey: '' });
            selectAgent(null);
            if (agentLabel) {
               agentLabel.textContent = 'Waiting...';
            }
          }
        }
      });
    }

    updateVoiceStatus();
    renderVoiceParticipants();

    // --- AGENT SELECTION LOGIC ---
    const dispatchInput = document.getElementById('dispatch-input');
    const agentLabel = document.getElementById('active-agent-label');
    const agentCards = Array.from(document.querySelectorAll('.agent-card[data-agent-key]'));
    
    const agents = {
      architect: { id: 'agent-architect', label: 'Ari (Architect)', keywords: ['architecture', 'design', 'system', 'plan', 'structure', 'scalable', 'diagram'] },
      researcher: { id: 'agent-researcher', label: 'Nova (Researcher)', keywords: ['research', 'find', 'compare', 'docs', 'explain', 'why', 'sources'] },
      coder: { id: 'agent-coder', label: 'Byte (Coder)', keywords: ['code', 'implement', 'write', 'function', 'class', 'create', 'build', 'api'] },
      debugger: { id: 'agent-debugger', label: 'Patch (Debugger)', keywords: ['fix', 'bug', 'error', 'crash', 'issue', 'fail', 'broken', 'exception'] },
      data: { id: 'agent-data', label: 'Quill (Data)', keywords: ['data', 'scrape', 'collect', 'extract', 'parse', 'csv', 'json'] },
      devops: { id: 'agent-devops', label: 'Pulse (DevOps)', keywords: ['deploy', 'cloud', 'aws', 'docker', 'ci/cd', 'pipeline', 'server', 'monitor'] },
    };

    function selectAgent(agentKey) {
      // Reset all
      Object.keys(agents).forEach(key => {
        const el = document.getElementById(agents[key].id);
        if(el) {
            el.classList.remove('selected', 'thinking');
            const stateText = el.querySelector('.agent-state-text');
            if(stateText) stateText.textContent = 'Ready';
        }
      });

      // Activate one
      if (agentKey && agents[agentKey]) {
        const el = document.getElementById(agents[agentKey].id);
        if(el) {
            el.classList.add('selected');
            agentLabel.textContent = 'Agent: ' + agents[agentKey].label;
            agentLabel.style.color = getComputedStyle(el).getPropertyValue('--agent-color');
            setActiveAgent(agentKey, { updateVoice: false, greet: false });
            
            // Simulate "Thinking" shortly after selection to show it's "Alive"
            setTimeout(() => {
                if(el.classList.contains('selected')) {
                    el.classList.add('thinking');
                    const stateText = el.querySelector('.agent-state-text');
                    if(stateText) stateText.textContent = 'Thinking...';
                }
            }, 300);
        }
      } else {
        agentLabel.textContent = 'Waiting for input...';
        agentLabel.style.color = 'var(--strata-text-muted)';
        setActiveAgent(null, { updateVoice: false, greet: false });
      }
    }

    if (agentCards.length > 0) {
      for (const el of agentCards) {
        el.addEventListener('click', () => {
          const key = el.dataset.agentKey;
          if (key) selectAgent(key);
        });

        el.addEventListener('dragstart', (ev) => {
          try {
            el.classList.add('dragging');
            ev.dataTransfer.effectAllowed = 'move';
            ev.dataTransfer.setData('text/plain', el.dataset.agentKey || '');
          } catch {
            // ignore
          }
        });

        el.addEventListener('dragend', () => {
          el.classList.remove('dragging');
        });
      }
    }

    if (voiceParticipantsEl) {
      voiceParticipantsEl.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        voiceParticipantsEl.classList.add('drop-ready');
      });
      voiceParticipantsEl.addEventListener('dragleave', () => {
        voiceParticipantsEl.classList.remove('drop-ready');
      });
      voiceParticipantsEl.addEventListener('drop', (ev) => {
        ev.preventDefault();
        voiceParticipantsEl.classList.remove('drop-ready');
        const key = ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '';
        if (!key || !agents[key]) return;
        selectAgent(key);
        setActiveAgent(key, { updateVoice: true, greet: true });
      });
    }

    if (dispatchInput) {
      dispatchInput.addEventListener('input', (e) => {
        const text = e.target.value.toLowerCase();
        let matched = null;
        for (const [key, data] of Object.entries(agents)) {
          if (data.keywords.some(k => text.includes(k))) {
            matched = key;
            break; 
          }
        }
        selectAgent(matched);
      });
      
      dispatchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const task = String(e.target.value || '').trim();
        if (!task) return;
        e.preventDefault();

        const currentText = agentLabel && agentLabel.textContent ? agentLabel.textContent : '';
        if (!currentText.includes('Waiting')) {
          const activeId = Object.values(agents).find(a => currentText.includes(a.label))?.id;
          const el = activeId ? document.getElementById(activeId) : null;
          if (el) {
            el.classList.add('thinking');
            const stateText = el.querySelector('.agent-state-text');
            if (stateText) stateText.textContent = 'Thinking...';
          }
        }

        if (typeof chatInput !== 'undefined' && chatInput) {
          chatInput.value = task;
          sendChat();
        }

        dispatchInput.value = '';
      });
    }

    // --- MAIN EDITOR INSERT LOGIC ---
    const input = document.getElementById('input');
    const insertBtn = document.getElementById('insert');

    function insertIntoEditor() {
      if (!input) return;
      vscode.postMessage({ type: 'insertText', text: input.value });
    }

    if (insertBtn) insertBtn.addEventListener('click', insertIntoEditor);
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          insertIntoEditor();
        }
      });
    }

    // --- CHAT LOGIC ---
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send-btn');
    const chatMessages = document.getElementById('chat-messages');
    const chatNewBtn = document.getElementById('chat-new-btn');
    const chatHistoryBtn = document.getElementById('chat-history-btn');
    const chatHistoryPopover = document.getElementById('chat-history-popover');
    const chatAttachBtn = document.getElementById('chat-attach-btn');
    const chatAttachmentLabel = document.getElementById('chat-attachment-label');
    const chatRoot = document.querySelector('.chat-root');

    const hiddenFileInput = document.createElement('input');
    hiddenFileInput.type = 'file';
    hiddenFileInput.multiple = false;
    hiddenFileInput.accept = 'image/*,video/*,application/pdf,text/plain,text/markdown,.md,.txt,.pdf,.doc,.docx';
    hiddenFileInput.style.display = 'none';
    document.body.appendChild(hiddenFileInput);

    let pendingThinkingBubble = null;

    const CHAT_STORAGE_KEY = 'strata-chat-history-v1';
    const CHAT_SESSIONS_KEY = 'strata-chat-sessions-v1';
    const CHAT_ACTIVE_SESSION_KEY = 'strata-chat-active-session-v1';
    const TOOL_LOG_KEY = 'strata-tool-log-v1';

    let chatSessions = [];
    let activeChatSessionId = null;
    let chatHistory = [];
    let toolLog = [];

    let toolsQueue = [];
    let toolsIndex = -1;
    let waitingForToolResult = false;
    let currentToolsPanel = null;

    // Auto-continue state: keeps the agent working after tools finish
    let autoContinueEnabled = true;
    let autoContinueInProgress = false;

    const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

    function parseMarkdown(raw) {
      if (!raw) return '';
      var BT = String.fromCharCode(96);
      var text = String(raw);
      text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      var codeBlocks = [];
      var cbRe = new RegExp(BT+BT+BT+'([\\s\\S]*?)'+BT+BT+BT, 'g');
      text = text.replace(cbRe, function(m, c) { codeBlocks.push(c); return '%%CB' + (codeBlocks.length - 1) + '%%'; });
      var inlineCodes = [];
      var icRe = new RegExp(BT+'([^'+BT+']+)'+BT, 'g');
      text = text.replace(icRe, function(m, c) { inlineCodes.push(c); return '%%IC' + (inlineCodes.length - 1) + '%%'; });
      text = text.replace(/[*][*]([^*]+)[*][*]/g, '<b>$1</b>');
      text = text.replace(/[*]([^*]+)[*]/g, '<i>$1</i>');
      text = text.replace(/^#{3}\s+(.*)$/gm, '<strong style="font-size:1.1em;">$1</strong>');
      text = text.replace(/^#{2}\s+(.*)$/gm, '<strong style="font-size:1.2em;">$1</strong>');
      text = text.replace(/^#{1}\s+(.*)$/gm, '<strong style="font-size:1.3em;">$1</strong>');
      text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:#38bdf8;">$1</a>');
      text = text.replace(/^\s*[-]\s+(.*)$/gm, '&bull; $1');
      text = text.replace(/\n/g, '<br>');
      for (var j = 0; j < inlineCodes.length; j++) {
        text = text.replace('%%IC' + j + '%%', '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:4px;font-size:0.92em;">' + inlineCodes[j] + '</code>');
      }
      for (var k = 0; k < codeBlocks.length; k++) {
        text = text.replace('%%CB' + k + '%%', '<pre style="background:rgba(0,0,0,0.3);padding:10px;border-radius:6px;overflow-x:auto;margin:4px 0;"><code>' + codeBlocks[k] + '</code></pre>');
      }
      return text;
    }

    function appendChatMessage(role, text, options) {
      if (!chatMessages) return null;
      const div = document.createElement('div');
      div.className = 'chat-message ' + (role === 'user' ? 'user' : 'assistant');
      if (role === 'assistant') {
        div.innerHTML = parseMarkdown(text);
      } else {
        div.textContent = text;
      }
      chatMessages.appendChild(div);
      chatMessages.scrollTop = chatMessages.scrollHeight;

      const shouldPersist = !options || options.persist !== false;
      if (shouldPersist) {
        chatHistory.push({ role, text });
        try {
          localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatHistory));
        } catch (e) {
          // ignore storage errors
        }

        const session = chatSessions.find((s) => s && s.id === activeChatSessionId);
        if (session) {
          session.messages = chatHistory;
          session.updatedAt = Date.now();
          if ((!session.title || session.title === 'New chat') && role === 'user' && typeof text === 'string') {
            const trimmed = text.trim();
            if (trimmed) {
              session.title = trimmed.length > 38 ? trimmed.slice(0, 38) + '…' : trimmed;
            }
          }
          try {
            localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(chatSessions));
            localStorage.setItem(CHAT_ACTIVE_SESSION_KEY, String(activeChatSessionId || ''));
          } catch (e) {
            // ignore
          }
        }
      }

      return div;
    }

    function arrayBufferToBase64(buffer) {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }

    function attachFileFromBrowserFile(file) {
      if (!file) return;
      if (typeof file.size === 'number' && file.size > MAX_ATTACHMENT_BYTES) {
        appendChatMessage('assistant', 'Attachment too large (max 25MB). Please attach a smaller file.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const base64 = arrayBufferToBase64(reader.result);
          vscode.postMessage({
            type: 'chat-attach-bytes',
            name: file.name || 'attachment',
            mimeType: file.type || '',
            size: typeof file.size === 'number' ? file.size : 0,
            data: base64,
          });
          if (chatAttachmentLabel) {
            chatAttachmentLabel.textContent = file.name || '';
          }
        } catch (e) {
          appendChatMessage('assistant', 'Failed to read attachment.');
        }
      };
      reader.onerror = () => {
        appendChatMessage('assistant', 'Failed to read attachment.');
      };
      reader.readAsArrayBuffer(file);
    }

    if (hiddenFileInput) {
      hiddenFileInput.addEventListener('change', (event) => {
        const inputEl = event.target;
        if (!inputEl || !inputEl.files || inputEl.files.length === 0) {
          return;
        }
        const file = inputEl.files[0];
        attachFileFromBrowserFile(file);
        inputEl.value = '';
      });
    }

    if (chatRoot) {
      chatRoot.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
      });
      chatRoot.addEventListener('drop', (event) => {
        event.preventDefault();
        const dt = event.dataTransfer;
        if (!dt || !dt.files || dt.files.length === 0) return;
        const file = dt.files[0];
        attachFileFromBrowserFile(file);
      });
    }

    window.addEventListener('paste', (event) => {
      if (!event.clipboardData || !event.clipboardData.files || event.clipboardData.files.length === 0) {
        return;
      }
      const file = event.clipboardData.files[0];
      attachFileFromBrowserFile(file);
    });

    if (chatAttachBtn) {
      chatAttachBtn.addEventListener('click', () => {
        if (hiddenFileInput) {
          hiddenFileInput.click();
        } else {
          vscode.postMessage({ type: 'chat-attach' });
        }
      });
    }

    function saveToolLog() {
      try {
        const sid = activeChatSessionId || 'default';
        localStorage.setItem(TOOL_LOG_KEY + ':' + sid, JSON.stringify(toolLog));
      } catch (e) {
        // ignore
      }
    }

    function loadToolLog() {
      let saved = null;
      try {
        const sid = activeChatSessionId || 'default';
        saved = localStorage.getItem(TOOL_LOG_KEY + ':' + sid);
      } catch (e) {
        saved = null;
      }
      if (!saved) {
        toolLog = [];
        return;
      }
      try {
        const parsed = JSON.parse(saved);
        toolLog = Array.isArray(parsed) ? parsed : [];
      } catch {
        toolLog = [];
      }
    }

    function setActiveChatSession(id) {
      const session = chatSessions.find((s) => s && s.id === id);
      if (!session) return;
      activeChatSessionId = id;
      chatHistory = Array.isArray(session.messages) ? session.messages : [];
      if (chatMessages) {
        chatMessages.innerHTML = '';
        chatHistory.forEach((m) => {
          if (!m || typeof m.text !== 'string') return;
          const role = m.role === 'assistant' ? 'assistant' : 'user';
          appendChatMessage(role, m.text, { persist: false });
        });
      }
      try {
        localStorage.setItem(CHAT_ACTIVE_SESSION_KEY, String(activeChatSessionId || ''));
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatHistory));
      } catch (e) {
        // ignore
      }
      if (chatAttachmentLabel) chatAttachmentLabel.textContent = '';
      vscode.postMessage({ type: 'clearAttachment' });
      loadToolLog();
    }

    function createNewChatSession() {
      const id = 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const session = { id, title: 'New chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      chatSessions.unshift(session);
      try {
        localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(chatSessions));
      } catch (e) {
        // ignore
      }
      setActiveChatSession(id);
      if (chatAttachmentLabel) chatAttachmentLabel.textContent = '';
      vscode.postMessage({ type: 'clearAttachment' });
      vscode.postMessage({ type: 'clearContextCache' });
      return id;
    }

    function hideHistoryPopover() {
      if (!chatHistoryPopover) return;
      chatHistoryPopover.style.display = 'none';
    }

    function renderHistoryPopover() {
      if (!chatHistoryPopover) return;
      chatHistoryPopover.innerHTML = '';
      if (!Array.isArray(chatSessions) || chatSessions.length === 0) {
        const empty = document.createElement('div');
        empty.style.fontSize = '11px';
        empty.style.color = 'var(--strata-text-muted)';
        empty.textContent = 'No chats yet.';
        chatHistoryPopover.appendChild(empty);
        return;
      }
      chatSessions.slice(0, 30).forEach((s) => {
        if (!s || !s.id) return;
        const row = document.createElement('div');
        row.className = 'chat-history-row';

        const btn = document.createElement('div');
        btn.className = 'chat-history-item' + (s.id === activeChatSessionId ? ' active' : '');
        btn.textContent = s.title || 'New chat';
        btn.addEventListener('click', () => {
          setActiveChatSession(s.id);
          hideHistoryPopover();
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'chat-history-del-btn';
        delBtn.textContent = '×';
        delBtn.title = 'Delete this chat';
        delBtn.addEventListener('click', (e) => {
             e.stopPropagation();
             if(confirm('Delete chat "' + (s.title||'New chat') + '"?')) {
                  chatSessions = chatSessions.filter(x => x.id !== s.id);
                  try {
                    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(chatSessions));
                  } catch (e) {}
                  
                  if (activeChatSessionId === s.id) {
                      if (chatSessions.length > 0) setActiveChatSession(chatSessions[0].id);
                      else createNewChatSession();
                  }
                  renderHistoryPopover();
             }
        });

        row.appendChild(btn);
        row.appendChild(delBtn);
        chatHistoryPopover.appendChild(row);
      });
    }

    function toggleHistoryPopover() {
      if (!chatHistoryPopover) return;
      const isOpen = chatHistoryPopover.style.display === 'block';
      if (isOpen) {
        chatHistoryPopover.style.display = 'none';
        return;
      }
      renderHistoryPopover();
      chatHistoryPopover.style.display = 'block';
    }

    function loadChatHistory() {
      if (!chatMessages) return;
      let sessionsRaw = null;
      try {
        sessionsRaw = localStorage.getItem(CHAT_SESSIONS_KEY);
      } catch (e) {
        sessionsRaw = null;
      }
      if (sessionsRaw) {
        try {
          const parsed = JSON.parse(sessionsRaw);
          chatSessions = Array.isArray(parsed) ? parsed : [];
        } catch {
          chatSessions = [];
        }
      }

      let activeId = null;
      try {
        activeId = localStorage.getItem(CHAT_ACTIVE_SESSION_KEY);
      } catch (e) {
        activeId = null;
      }

      if (Array.isArray(chatSessions) && chatSessions.length > 0) {
        const found = chatSessions.find((s) => s && s.id === activeId);
        setActiveChatSession(found ? found.id : chatSessions[0].id);
        return;
      }

      let legacy = null;
      try {
        legacy = localStorage.getItem(CHAT_STORAGE_KEY);
      } catch (e) {
        legacy = null;
      }

      if (legacy) {
        try {
          const parsed = JSON.parse(legacy);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const id = createNewChatSession();
            const session = chatSessions.find((s) => s && s.id === id);
            if (session) {
              session.messages = parsed.map((m) => {
                if (!m || typeof m.text !== 'string') return null;
                return { role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text };
              }).filter(Boolean);
              session.title = session.title || 'Chat';
              session.updatedAt = Date.now();
              try {
                localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(chatSessions));
              } catch {
                // ignore
              }
              setActiveChatSession(id);
            }
            return;
          }
        } catch {
          // ignore
        }
      }

      createNewChatSession();
    }

    loadToolLog();
    loadChatHistory();

    if (chatNewBtn) {
      chatNewBtn.addEventListener('click', () => {
        hideHistoryPopover();
        createNewChatSession();
        toolsQueue = [];
        toolsIndex = -1;
        waitingForToolResult = false;
        autoContinueInProgress = false;
        if (currentToolsPanel && currentToolsPanel.parentElement) {
          currentToolsPanel.parentElement.removeChild(currentToolsPanel);
        }
        currentToolsPanel = null;
      });
    }

    if (chatHistoryBtn) {
      chatHistoryBtn.addEventListener('click', () => {
        toggleHistoryPopover();
      });
    }

    const chatDeleteBtn = document.getElementById('chat-delete-btn');
    if (chatDeleteBtn) {
      chatDeleteBtn.addEventListener('click', () => {
        if (confirm('Delete this chat permanently?')) {
          // Clear current chat
          chatHistory = [];
          if (chatMessages) chatMessages.innerHTML = '';
          toolsQueue = [];
          toolsIndex = -1;
          waitingForToolResult = false;
          autoContinueInProgress = false;
          if (currentToolsPanel && currentToolsPanel.parentElement) {
            currentToolsPanel.parentElement.removeChild(currentToolsPanel);
          }
          currentToolsPanel = null;
          
          // Delete from storage and create new session
          vscode.postMessage({ type: 'deleteChat', sessionId: activeChatSessionId });
          createNewChatSession();
        }
      });
    }

    document.addEventListener('click', (ev) => {
      if (!chatHistoryPopover || chatHistoryPopover.style.display !== 'block') return;
      const t = ev.target;
      if (chatHistoryPopover.contains(t)) return;
      if (chatHistoryBtn && chatHistoryBtn.contains(t)) return;
      hideHistoryPopover();
    });

    function showThinkingBubble() {
      if (!chatMessages) return null;
      const div = document.createElement('div');
      div.className = 'chat-message assistant thinking';
      const dots = document.createElement('div');
      dots.className = 'chat-thinking-dots';
      for (let i = 0; i < 3; i++) {
        const span = document.createElement('span');
        dots.appendChild(span);
      }
      div.appendChild(dots);
      chatMessages.appendChild(div);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return div;
    }

    function setWorkingState(isWorking) {
      if (!chatSendBtn) return;
      if (isWorking) {
        chatSendBtn.classList.add('working');
        chatSendBtn.title = 'Stop';
        autoContinueEnabled = true;
      } else {
        chatSendBtn.classList.remove('working');
        chatSendBtn.title = 'Send';
        autoContinueEnabled = false;
      }
    }

    function stopAgent() {
      // Clear queues and flags
      toolsQueue = [];
      toolsIndex = -1;
      waitingForToolResult = false;
      autoContinueInProgress = false;
      autoContinueEnabled = false;
      
      // Remove UI elements
      if (currentToolsPanel && currentToolsPanel.parentElement) {
        currentToolsPanel.parentElement.removeChild(currentToolsPanel);
      }
      currentToolsPanel = null;
      if (pendingThinkingBubble && pendingThinkingBubble.parentElement) {
        pendingThinkingBubble.parentElement.removeChild(pendingThinkingBubble);
      }
      pendingThinkingBubble = null;
      
      // Reset button
      setWorkingState(false);
      
      // Notify user
      appendChatMessage('assistant', '🛑 Agent stopped.');
    }

    function sendChat() {
      if (!chatInput) return;
      
      // If already working, this button acts as STOP
      if (chatSendBtn && chatSendBtn.classList.contains('working')) {
        stopAgent();
        return;
      }

      const value = chatInput.value.trim();
      if (!value) return;
      
      setWorkingState(true);
      
      appendChatMessage('user', value);
      // show animated thinking dots while Gemini is responding
      pendingThinkingBubble = showThinkingBubble();
      vscode.postMessage({ type: 'chat', text: value, history: chatHistory, toolLog });
      chatInput.value = '';
      // reset height back to one line
      chatInput.style.height = 'auto';
      if (chatAttachmentLabel) {
        chatAttachmentLabel.textContent = '';
      }
      // clear any previous pending tools when a new chat starts
      toolsQueue = [];
      toolsIndex = -1;
      waitingForToolResult = false;
      autoContinueInProgress = false;
      if (currentToolsPanel && currentToolsPanel.parentElement) {
        currentToolsPanel.parentElement.removeChild(currentToolsPanel);
      }
      currentToolsPanel = null;
    }

    function wireQuickStartButtons() {
      const root = document.querySelector('.chat-root') || document;
      const candidates = Array.from(root.querySelectorAll('button, a'));
      candidates.forEach((el) => {
        const label = String(el.textContent || '').trim().toLowerCase();
        if (label !== 'start project') return;
        if (el.dataset && el.dataset.strataWired === '1') return;
        if (el.dataset) el.dataset.strataWired = '1';
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          if (!chatInput) return;
          chatInput.value = 'start project';
          sendChat();
        });
      });
    }

    if (chatSendBtn) {
      chatSendBtn.addEventListener('click', sendChat);
    }

    wireQuickStartButtons();

    function autoResizeChatInput() {
      if (!chatInput) return;
      chatInput.style.height = 'auto';
      chatInput.style.height = chatInput.scrollHeight + 'px';
    }

    if (chatInput) {
      autoResizeChatInput();
      chatInput.addEventListener('input', () => {
        autoResizeChatInput();
      });
      chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          sendChat();
        }
      });
    }

    if (chatAttachBtn) {
      chatAttachBtn.addEventListener('click', () => {
        if (hiddenFileInput) {
          hiddenFileInput.click();
        } else {
          vscode.postMessage({ type: 'chat-attach' });
        }
      });
    }

    function requestAutoContinue() {
      if (!autoContinueEnabled) return;
      if (autoContinueInProgress) return;
      autoContinueInProgress = true;
      if (pendingThinkingBubble && pendingThinkingBubble.parentElement) {
        pendingThinkingBubble.parentElement.removeChild(pendingThinkingBubble);
      }
      pendingThinkingBubble = showThinkingBubble();
      vscode.postMessage({ type: 'autoContinue', history: chatHistory, toolLog });
    }

    function describeToolAction(action) {
      if (!action || !action.type) return 'Unknown action';
      const path = action.path || '';
      switch (action.type) {
        case 'runTerminalCommand': {
          const cmd = action.command || '';
          const cwdSuffix = action.cwd && typeof action.cwd === 'string' && action.cwd.trim()
            ? ' (in ' + action.cwd + ')'
            : '';
          return 'Run: ' + cmd + cwdSuffix;
        }
        case 'createDirectory':
          return 'Create directory: ' + path;
        case 'createOrOverwriteFile':
          return 'Create/overwrite file: ' + path;
        case 'appendToFile':
          return 'Append to file: ' + path;
        case 'deletePath':
          return 'Delete path: ' + path;
        case 'openFile':
          return 'Open file: ' + path;
        default:
          return 'Action: ' + action.type;
      }
    }

    function clearToolsSequence() {
      toolsQueue = [];
      toolsIndex = -1;
      waitingForToolResult = false;
      if (currentToolsPanel && currentToolsPanel.parentElement) {
        currentToolsPanel.parentElement.removeChild(currentToolsPanel);
      }
      currentToolsPanel = null;
    }

    function renderToolActionPanel(action) {
      if (!chatMessages || !action) {
        return null;
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'chat-message assistant';

      const panel = document.createElement('div');
      panel.className = 'chat-tools-panel';

      const title = document.createElement('div');
      title.className = 'chat-tools-title';
      title.textContent = 'Strata wants to run this action';
      panel.appendChild(title);

      const list = document.createElement('ul');
      list.className = 'chat-tools-list';
      const li = document.createElement('li');
      li.textContent = describeToolAction(action);
      list.appendChild(li);
      panel.appendChild(list);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'chat-tools-actions';

      const skipBtn = document.createElement('button');
      skipBtn.className = 'chat-tools-btn';
      skipBtn.textContent = 'Skip';
      skipBtn.addEventListener('click', () => {
        toolLog.push({ status: 'skipped', type: action.type, command: action.command, cwd: action.cwd, path: action.path, at: Date.now() });
        saveToolLog();
        if (wrapper.parentElement) {
          wrapper.parentElement.removeChild(wrapper);
        }
        waitingForToolResult = false;
        showNextToolAction();
      });

      const applyBtn = document.createElement('button');
      applyBtn.className = 'chat-tools-btn primary';
      applyBtn.textContent = 'Apply';
      applyBtn.addEventListener('click', () => {
        if (waitingForToolResult) return;
        waitingForToolResult = true;
        toolLog.push({ status: 'pending', type: action.type, command: action.command, cwd: action.cwd, path: action.path, at: Date.now() });
        saveToolLog();
        if (pendingThinkingBubble && pendingThinkingBubble.parentElement) {
          pendingThinkingBubble.parentElement.removeChild(pendingThinkingBubble);
        }
        pendingThinkingBubble = showThinkingBubble();
        vscode.postMessage({ type: 'applyTools', actions: [action] });
      });

      actionsRow.appendChild(skipBtn);
      actionsRow.appendChild(applyBtn);
      panel.appendChild(actionsRow);

      wrapper.appendChild(panel);
      chatMessages.appendChild(wrapper);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return wrapper;
    }

    function showNextToolAction() {
      console.log('[Strata Webview] showNextToolAction - queue length:', toolsQueue.length, 'index:', toolsIndex);
      
      if (!Array.isArray(toolsQueue) || toolsQueue.length === 0) {
        clearToolsSequence();
        return;
      }
      toolsIndex += 1;
      if (toolsIndex >= toolsQueue.length) {
        clearToolsSequence();
        // All actions from this batch are handled; ask the agent to keep going
        requestAutoContinue();
        return;
      }
      const action = toolsQueue[toolsIndex];
      if (!action) {
        showNextToolAction();
        return;
      }
      
      console.log('[Strata Webview] Processing action:', action.type, action.command || action.path || '');
      
      // AUTO-EXECUTE SAFE ACTIONS (no user approval needed)
      const isSafeAction = action.type !== 'deletePath';
      
      if (isSafeAction) {
        console.log('[Strata Webview] Auto-executing safe action');
        // Auto-execute without showing approval panel
        waitingForToolResult = true;
        toolLog.push({ status: 'auto-applied', type: action.type, command: action.command, cwd: action.cwd, path: action.path, at: Date.now() });
        saveToolLog();
        
        // Show brief status in chat
        const statusDiv = document.createElement('div');
        statusDiv.className = 'chat-message assistant';
        statusDiv.style.opacity = '0.7';
        statusDiv.style.fontSize = '11px';
        statusDiv.textContent = '▶ ' + describeToolAction(action);
        if (chatMessages) {
          chatMessages.appendChild(statusDiv);
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        if (pendingThinkingBubble && pendingThinkingBubble.parentElement) {
          pendingThinkingBubble.parentElement.removeChild(pendingThinkingBubble);
        }
        pendingThinkingBubble = showThinkingBubble();
        
        vscode.postMessage({ type: 'applyTools', actions: [action] });
        return;
      }
      
      console.log('[Strata Webview] Showing approval panel for destructive action');
      // DESTRUCTIVE ACTIONS (deletePath) still require approval
      if (currentToolsPanel && currentToolsPanel.parentElement) {
        currentToolsPanel.parentElement.removeChild(currentToolsPanel);
      }
      currentToolsPanel = renderToolActionPanel(action);
    }

    function startToolsSequence(tools) {
      if (!Array.isArray(tools) || tools.length === 0) {
        console.log('[Strata Webview] startToolsSequence called with empty tools');
        return;
      }
      
      console.log('[Strata Webview] startToolsSequence called with', tools.length, 'tools');

      function logKeyFor(action) {
        if (!action || typeof action.type !== 'string') return '';
        if (action.type === 'runTerminalCommand') {
          return 'runTerminalCommand|' + String(action.command || '') + '|' + String(action.cwd || '');
        }
        if (action.type === 'openFile' || action.type === 'createDirectory' || action.type === 'deletePath') {
          return action.type + '|' + String(action.path || '');
        }
        return '';
      }

      function isReadOnlyTerminal(action) {
        if (!action || action.type !== 'runTerminalCommand') return false;
        const cmd = String(action.command || '').trim();
        return /^(cat|type)\s+/i.test(cmd);
      }

      // Only dedup within the same response - DON'T skip based on previous logs
      // This allows running the same command multiple times
      const seen = new Set();

      const filtered = tools.filter((action) => {
        if (!action || typeof action.type !== 'string') return false;
        if (isReadOnlyTerminal(action)) {
          console.log('[Strata Webview] Skipping read-only terminal command');
          return false;
        }
        const key = logKeyFor(action);
        if (key && seen.has(key)) {
          console.log('[Strata Webview] Skipping duplicate in same batch:', key);
          return false;
        }
        if (key) seen.add(key);
        return true;
      });

      console.log('[Strata Webview] Filtered to', filtered.length, 'tools');
      
      toolsQueue = filtered.slice();
      toolsIndex = -1;
      waitingForToolResult = false;
      showNextToolAction();
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || !message.type) return;
      if (message.type === 'chatResponse') {
        autoContinueInProgress = false;
        // remove thinking bubble if it is still visible
        if (pendingThinkingBubble && pendingThinkingBubble.parentElement) {
          pendingThinkingBubble.parentElement.removeChild(pendingThinkingBubble);
        }
        pendingThinkingBubble = null;
        // Also remove upload bubble if present
        const uploadBubble = document.getElementById('upload-status-bubble');
        if (uploadBubble && uploadBubble.parentElement) uploadBubble.parentElement.removeChild(uploadBubble);
        appendChatMessage('assistant', message.text || '');
        
        // Voice Response
        if (voiceState.connected && message.text) {
          speak(message.text);
        }

        const tools = Array.isArray(message.tools) ? message.tools : [];
        if (tools.length > 0) {
          startToolsSequence(tools);
        } else {
          // No tools = done with this turn
          setWorkingState(false);
        }
      } else if (message.type === 'attachmentSelected') {
        if (chatAttachmentLabel) {
          chatAttachmentLabel.textContent = message.name || '';
        }
      } else if (message.type === 'uploadStatus') {
        const existingUploadBubble = document.getElementById('upload-status-bubble');
        if (message.status === 'uploading' || message.status === 'processing') {
          if (!existingUploadBubble && chatMessages) {
            const bubble = document.createElement('div');
            bubble.id = 'upload-status-bubble';
            bubble.className = 'chat-message assistant thinking';
            bubble.innerHTML = '<span class="upload-spinner" style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.2);border-top-color:var(--strata-accent);border-radius:50%;animation:spin 0.8s linear infinite;margin-right:8px;vertical-align:middle;"></span><span style="opacity:0.8;">' + (message.status === 'uploading' ? 'Uploading file...' : 'Processing file...') + '</span>';
            chatMessages.appendChild(bubble);
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (existingUploadBubble) {
            existingUploadBubble.innerHTML = '<span class="upload-spinner" style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.2);border-top-color:var(--strata-accent);border-radius:50%;animation:spin 0.8s linear infinite;margin-right:8px;vertical-align:middle;"></span><span style="opacity:0.8;">' + (message.status === 'uploading' ? 'Uploading file...' : 'Processing file...') + '</span>';
          }
        } else if (existingUploadBubble && existingUploadBubble.parentElement) {
          existingUploadBubble.parentElement.removeChild(existingUploadBubble);
        }
        // Also clear the small label spinner
        const uploadStatusEl = document.getElementById('upload-status');
        if (uploadStatusEl) uploadStatusEl.className = 'upload-status';
      } else if (message.type === 'toolsApplied') {
        if (pendingThinkingBubble && pendingThinkingBubble.parentElement) {
          pendingThinkingBubble.parentElement.removeChild(pendingThinkingBubble);
        }
        pendingThinkingBubble = null;
        const summary = message.summary || {};
        const applied = typeof summary.applied === 'number' ? summary.applied : 0;
        const errors = Array.isArray(summary.errors) ? summary.errors : [];
        const results = Array.isArray(summary.results) ? summary.results : [];

        function toolKeyForLog(entry) {
          if (!entry || typeof entry.type !== 'string') return '';
          if (entry.type === 'runTerminalCommand') {
            return 'runTerminalCommand|' + String(entry.command || '') + '|' + String(entry.cwd || '');
          }
          if (entry.type === 'openFile' || entry.type === 'createDirectory' || entry.type === 'deletePath' || entry.type === 'createOrOverwriteFile' || entry.type === 'appendToFile') {
            return entry.type + '|' + String(entry.path || '');
          }
          return '';
        }

        // Update pending entries with final results (including successful output tails)
        if (results.length > 0) {
          results.forEach((r) => {
            if (!r || typeof r !== 'object') return;
            const a = r.action && typeof r.action === 'object' ? r.action : null;
            if (!a || typeof a.type !== 'string') return;
            const entry = {
              type: a.type,
              command: a.command,
              cwd: a.cwd,
              path: a.path,
            };
            const key = toolKeyForLog(entry);
            let updated = false;
            if (key) {
              for (let i = toolLog.length - 1; i >= 0; i--) {
                const t = toolLog[i];
                if (!t || t.status !== 'pending') continue;
                const k2 = toolKeyForLog(t);
                if (k2 && k2 === key) {
                  t.status = typeof r.status === 'string' ? r.status : 'success';
                  if (typeof r.message === 'string') t.message = r.message;
                  if (typeof r.outputTail === 'string') t.outputTail = r.outputTail;
                  if (typeof r.exitCode === 'number') t.exitCode = r.exitCode;
                  t.at = Date.now();
                  updated = true;
                  break;
                }
              }
            }
            if (!updated) {
              toolLog.push({
                status: typeof r.status === 'string' ? r.status : 'success',
                type: a.type,
                command: a.command,
                cwd: a.cwd,
                path: a.path,
                message: typeof r.message === 'string' ? r.message : '',
                outputTail: typeof r.outputTail === 'string' ? r.outputTail : '',
                exitCode: typeof r.exitCode === 'number' ? r.exitCode : 0,
                at: Date.now(),
              });
            }
          });
          saveToolLog();
        }

        if (errors.length > 0) {
          errors.forEach((e) => {
            const a = e && e.action && typeof e.action === 'object' ? e.action : null;
            if (!a) return;
            toolLog.push({ status: 'failed', type: a.type, command: a.command, cwd: a.cwd, path: a.path, message: e && typeof e.message === 'string' ? e.message : '', at: Date.now() });
          });
          saveToolLog();
        }
        let text = 'Applied ' + applied + ' action' + (applied === 1 ? '' : 's') + '.';
        if (errors.length > 0) {
          text += ' ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + ' when applying tools.';
        }
        appendChatMessage('assistant', text);
        waitingForToolResult = false;
        if (currentToolsPanel && currentToolsPanel.parentElement) {
          currentToolsPanel.parentElement.removeChild(currentToolsPanel);
        }
        currentToolsPanel = null;
        showNextToolAction();
      }
    });
    function playMusic(wrapper) {
      if (wrapper.dataset.playing) return;
      wrapper.dataset.playing = 'true';
      
      const img = wrapper.querySelector('img');
      const toast = wrapper.querySelector('.music-toast');
      
      if (toast) {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
      }
      
      // Create iframe immediately to capture user gesture for autoplay
      const iframe = document.createElement('iframe');
      // Put autoplay=1 FIRST. Add playsinline.
      iframe.src = "https://www.youtube.com/embed/MMFj8uDubsE?autoplay=1&list=RDMMFj8uDubsE&start_radio=1&controls=0&playsinline=1";
      iframe.width = "100%";
      iframe.height = "100%";
      iframe.frameBorder = "0";
      iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
      iframe.allowFullscreen = true;
      
      // Style for transition
      Object.assign(iframe.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        opacity: '0.01', /* Avoid 0 to prevent block */
        transition: 'opacity 1.5s ease',
        borderRadius: '12px',
        zIndex: '5'
      });

      wrapper.appendChild(iframe);
      
      // Trigger crossfade
      requestAnimationFrame(() => {
        // Force reflow
        iframe.offsetHeight;
        iframe.style.opacity = '1';
        if (img) {
            img.style.transition = 'opacity 1.5s ease';
            img.style.opacity = '0';
        }
      });
    }
  </script>
</body>
</html>`; // close the template string here
}

function deactivate() { }

module.exports = {
  activate,
  deactivate,
};

