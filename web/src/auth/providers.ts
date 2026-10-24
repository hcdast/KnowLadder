/** Enable only providers backed by a real integration. Credentials belong on the server. */
export interface LoginProvider {
  id: string;
  label: string;
  start: () => void | Promise<void>;
}
export const loginProviders: readonly LoginProvider[] = [];
