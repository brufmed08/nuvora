// Se evalúa antes que el resto: la aplicación debe saber desde el inicio que está en demostración.
globalThis.__SIGILO_API__ = async () => {
  throw new Error("La demostración aún se está preparando.");
};
