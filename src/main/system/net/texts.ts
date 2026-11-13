export const addressInUse = (address: string): string =>
  `Another device on your network is already using ${address}. Choose a different number for the last part.`

export const APPLY_FAILED = "Those settings didn't work, so the box went back to its previous settings. " +
  'Check the address and router, then try again.'
export const NOT_ALLOWED = "The box isn't allowed to change its network settings. Restart the box and try again."
export const RESET_FAILED = "Couldn't set the network back to automatic. Switch the box off and on again, then try again."
export const NETWORK_BUSY = "The network is still busy. Wait two minutes, then try again."
export const WIFI_NOT_READY = "Wi-Fi setup isn't ready on this box yet. Use a network cable for now."

export class UserFacingError extends Error {}
