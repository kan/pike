import type mermaidType from "mermaid";

let mermaidInstance: typeof mermaidType | null = null;

export async function getMermaid(): Promise<typeof mermaidType> {
  if (!mermaidInstance) {
    const mod = await import("mermaid");
    mermaidInstance = mod.default;
    mermaidInstance.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "loose",
    });
  }
  return mermaidInstance;
}
