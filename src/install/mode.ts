export const INSTALL_MODES = ["remote", "local"] as const;

export type InstallMode = (typeof INSTALL_MODES)[number];

export function isInstallMode(value: string): value is InstallMode {
  return (INSTALL_MODES as readonly string[]).includes(value);
}

export function parseInstallMode(value: string): InstallMode {
  if (isInstallMode(value)) return value;
  throw new Error(`Unknown install mode "${value}". Valid: ${INSTALL_MODES.join(", ")}`);
}
