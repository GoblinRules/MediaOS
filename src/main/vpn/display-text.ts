/** Remove characters that can hide or rearrange text shown on screen. */
export function stripDisplayControls(text: string): string {
  return [...text].filter((char) => {
    const code = char.codePointAt(0)!
    return code >= 32 && !(code >= 127 && code <= 159) && code !== 0x200e && code !== 0x200f &&
      !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069)
  }).join('')
}
