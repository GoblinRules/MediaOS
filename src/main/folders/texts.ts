import { FolderAddSchema, FolderLoginSchema } from '@shared/ipc-contract'
import type { ShareAdd, ShareLogin } from '@shared/folder-types'
import { UserFacingError } from '../system/net/texts'

export function folderText(word: string, server = '', share = ''): string {
  switch (word) {
    case 'invalid': return "Those details don't look right. Check the computer name and the folder name."
    case 'too-many': return "MediaOS can keep up to 20 network folders. Remove one you don't use first."
    case 'exists': return 'That network folder is already added.'
    case 'not-found': return "That network folder isn't on this box any more."
    case 'unreachable': return `Can't reach ${server}. Check it's switched on and connected to the same network.`
    case 'auth': return `${server} didn't accept that user name and password. Check them and try again.`
    case 'no-share': return `${server} doesn't have a shared folder called ${share}. Check the name.`
    case 'busy': return 'The box is busy with another network folder. Try again in a moment.'
    case 'unavailable': return "Network folders aren't working on this box. Restart it and try again."
    default: return "Couldn't open that network folder. Check the details and try again."
  }
}

export function checkLogin(req: ShareLogin): ShareLogin {
  const parsed = FolderLoginSchema.safeParse(req)
  if (!parsed.success) throw new UserFacingError(folderText('invalid'))
  return parsed.data
}
export function checkAdd(req: ShareAdd): ShareAdd {
  const parsed = FolderAddSchema.safeParse(req)
  if (!parsed.success) throw new UserFacingError(folderText('invalid'))
  return parsed.data
}
