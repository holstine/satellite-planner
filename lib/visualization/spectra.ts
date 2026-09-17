/** Shared by legends and renderers; sensor colors do not depend on target status. */
export const spectra = {
  optical: { label: 'Optical', color: '#6ef2cc' },
  infrared: { label: 'Infrared', color: '#ff9854' },
  radar: { label: 'Radar', color: '#c49aff' },
  unknown: { label: 'Other / unknown', color: '#d4dde5' },
} as const;

export function spectrumStyle(sensor?: string) {
  return sensor && Object.hasOwn(spectra, sensor)
    ? spectra[sensor as keyof typeof spectra]
    : spectra.unknown;
}
