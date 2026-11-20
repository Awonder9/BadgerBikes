// Sharing inside the iOS/Android apps, whose web views can't download and (Android) have no Web Share: through
// the phone's own share sheet. A file is first written to the app's cache folder.
import { nativePlugins } from '.'

/** The plugin rejects with "Share canceled" when the sheet is closed without choosing an app. */
const canceled = (err: unknown) => /cancel/i.test(err instanceof Error ? err.message : String(err))

/** Resolves true once an app was chosen, false when the rider closed the sheet; rejects when sharing failed. */
async function shareSheet(options: { title: string; url?: string; files?: string[] }): Promise<boolean> {
  const { Share } = await nativePlugins()
  try {
    await Share.share({ ...options, dialogTitle: options.title })
    return true
  } catch (err) {
    if (canceled(err)) return false
    throw err
  }
}

/** A link (a dock, a ride). */
export function shareLink(title: string, url: string): Promise<boolean> {
  return shareSheet({ title, url })
}

/** A text file such as the GPX route. */
export async function shareTextFile(fileName: string, text: string, title: string): Promise<boolean> {
  const { Directory, Encoding, Filesystem } = await nativePlugins()
  const { uri } = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 })
  return shareSheet({ title, files: [uri] })
}
