// Which first-run setup step is showing. Kept outside the screen so Recovery can jump to the network step.
import { createStore } from '../lib/store'

export type SetupStep = 'welcome' | 'network' | 'libraries' | 'done'
export const SETUP_ORDER: SetupStep[] = ['welcome', 'network', 'libraries', 'done']

export const setupStep = createStore<SetupStep>('welcome')
