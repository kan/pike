import { listen } from "@tauri-apps/api/event";
import { useTabStore } from "../stores/tabs";
import { useProjectStore } from "../stores/project";
import { cliGetInitialAction, cliSetPendingAction, openProjectWindow, type CliAction } from "../lib/tauri";
import type { ProjectConfig } from "../types/project";
import { basename } from "../lib/paths";

let initialized = false;

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

function isUnderRoot(filePath: string, root: string): boolean {
  const f = normalizePath(filePath);
  const r = normalizePath(root);
  return f.startsWith(r + "/") || f === r;
}

/** Find the project whose root best matches the file path (longest root wins). */
function findBestProject(filePath: string, projects: ProjectConfig[]): ProjectConfig | null {
  let best: ProjectConfig | null = null;
  let bestLen = 0;
  for (const p of projects) {
    if (isUnderRoot(filePath, p.root) && p.root.length > bestLen) {
      best = p;
      bestLen = p.root.length;
    }
  }
  return best;
}

/** Derive a parent directory suitable as a project root from a file path. */
function deriveProjectRoot(filePath: string): string {
  const sep = filePath.includes("\\") ? "\\" : "/";
  const parts = filePath.split(sep);
  parts.pop(); // remove filename
  return parts.join(sep);
}

async function handleAction(action: CliAction) {
  if (action.action === "none") return;

  const projectStore = useProjectStore();
  const tabStore = useTabStore();

  if (action.action === "openFile") {
    let targetProject = findBestProject(action.path, projectStore.projects);

    if (!targetProject) {
      const root = deriveProjectRoot(action.path);
      const name = basename(root) || "Untitled";
      const id = crypto.randomUUID();
      await projectStore.addProject({
        id,
        name,
        root,
        shell: { kind: "powershell" },
        pinnedTabs: [],
        lastOpened: new Date().toISOString(),
      });
      targetProject = projectStore.projects.find((p) => p.id === id) ?? null;
      if (!targetProject) return;
    }

    if (projectStore.currentProject?.id === targetProject.id) {
      tabStore.addEditorTab({ path: action.path, initialLine: action.line ?? undefined, reload: true });
    } else {
      // Register the action so the new window picks it up via cli_get_initial_action
      const windowLabel = `project-${targetProject.id}`;
      await cliSetPendingAction(windowLabel, action);
      await openProjectWindow(targetProject.id);
    }
  } else if (action.action === "openDirectory") {
    const normalized = normalizePath(action.path);
    const match = projectStore.projects.find(
      (p) => normalizePath(p.root) === normalized
    );
    if (match) {
      if (projectStore.currentProject?.id !== match.id) {
        await openProjectWindow(match.id);
      }
    }
  }
}

export async function initCliOpen() {
  if (initialized) return;
  initialized = true;

  await listen<CliAction>("cli_open", (event) => {
    handleAction(event.payload);
  });

  const initial = await cliGetInitialAction();
  if (initial.action !== "none") {
    handleAction(initial);
  }
}
