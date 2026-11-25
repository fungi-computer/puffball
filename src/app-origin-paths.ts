/** Shared App-origin routing namespaces; customer route policy consumes these exact roots. */
export const appOriginPaths = {
  publicSites: "/s",
  unlistedSites: "/u",
  privateSites: "/p",
  surfaceAssets: "/surfaces",
  installedApps: "/installed-apps",
  privatePreviews: "/private-apps",
} as const;
