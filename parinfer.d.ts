// Ambient declarations for the untyped CJS package `parinfer`
// (https://www.npmjs.com/package/parinfer, by Shaun Lebron).

declare module "parinfer" {
  interface ParinferError {
    name: string;
    message: string;
  }
  interface ParinferOutput {
    text: string;
    error?: ParinferError;
  }
  interface Parinfer {
    indentMode(input: string, options?: Record<string, unknown>): ParinferOutput;
    version: string;
  }
  const parinfer: Parinfer;
  export default parinfer;
}
