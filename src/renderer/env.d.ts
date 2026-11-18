/// <reference types="vite/client" />
import type { Workbench } from '../shared/api'
declare global {
  interface Window { readonly workbench: Workbench }
}
