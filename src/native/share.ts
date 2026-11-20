// Handing a file to another app inside the iOS/Android apps, whose web views can't download and (Android) have no
// Web Share: the file is written to the app's cache folder and offered through the phone's share sheet.
import { nativePlugins } from '.'

/** Resolves true once an app was chosen, false when the rider closed the share sheet; rejects when sharing failed. */
export async function shareTextFile(fileName: string, text: string, title: string): Promise<boolean> {
  const { Directory, Encoding, Filesystem, Share } = await nativePlugins()
  const { uri } = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 })
  try {
    await Share.share({ title, dialogTitle: title, files: [uri] })
    return true
  } catch (err) {
    // The plugin rejects with "Share canceled" when the sheet is closed without choosing an app.
    if (/cancel/i.test(err instanceof Error ? err.message : String(err))) return false
    throw err
  }
}
