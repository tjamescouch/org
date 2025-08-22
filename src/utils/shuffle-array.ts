// Fisher–Yates shuffle (non-mutating). Uses Math.random (simple PRNG).
export const shuffle = <T>(a: T[]): T[] => {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
};
