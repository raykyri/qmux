// Vite resolves `*.svg` imports to a URL string; Node cannot load the file at
// all. Tests that render a component importing icons register this to stand in
// for that, so the markup under test is reachable without a bundler.
export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".svg")) {
    return {
      url: "data:text/javascript,export default %22icon.svg%22",
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
