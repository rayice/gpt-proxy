export interface CodexModel {
  id: string
  name: string
  vendor: string
}

export interface State {
  accessToken?: string
  refreshToken?: string
  tokenExpires?: number
  accountId?: string

  models: Array<CodexModel>
  verbose: boolean
  showToken: boolean
}

export const state: State = {
  models: [],
  verbose: false,
  showToken: false,
}
