export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function gitStatusColor(status: string): string {
  switch (status) {
    case "M": return "var(--git-modify)";
    case "A": return "var(--git-add)";
    case "D": return "var(--git-delete)";
    case "?": return "var(--git-untracked)";
    case "R": return "var(--accent)";
    default:  return "var(--git-untracked)";
  }
}
