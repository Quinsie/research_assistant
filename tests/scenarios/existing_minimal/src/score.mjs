export function mean(values) {
  if (values.length === 0) {
    throw new Error("values must not be empty");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
