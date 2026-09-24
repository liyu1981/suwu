async function handler(input) {
  const text = await fs.promises.readFile("/app/data.txt");
  const stat = await fs.promises.stat("/app/data.txt");
  return {
    n: input.n,
    doubled: input.n * 2,
    text,
    size: stat.size,
    joined: path.join("/app", "data.txt"),
  };
}
