// Files that must run as real files (7za.exe, worker scripts) are unpacked next to app.asar in the packaged app.
export function unpacked(path: string): string {
  return path.replace(/app\.asar([\/])/, 'app.asar.unpacked$1')
}
