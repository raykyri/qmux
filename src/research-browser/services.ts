// Shared UI helpers use these only inside the Research Browser document.
// The host retains the native implementations.
export let browserServices:
  | {
      openExternalUrl: (url: string) => Promise<void>;
      writeClipboardText: (text: string) => Promise<void>;
    }
  | undefined;

export function setBrowserServices(
  services: NonNullable<typeof browserServices>,
) {
  browserServices = services;
}
