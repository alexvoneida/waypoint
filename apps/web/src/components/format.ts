export function formatDistance(meters: number): string {
  const km = meters / 1000;
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

export function formatElevation(meters: number): string {
  return `${Math.round(meters)} m`;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

export function formatFocalLength(mm: number): string {
  return `${Math.round(mm)}mm`;
}

export function formatAperture(fNumber: number): string {
  return `f/${fNumber.toFixed(1)}`;
}
