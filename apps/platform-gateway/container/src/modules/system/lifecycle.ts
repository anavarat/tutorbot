import {
  resolveContainerHealth,
  type ContainerBindings,
  type LoggerLike,
  type ProcessLike,
} from "./contracts.js";

export function logContainerStartup(
  logger: LoggerLike,
  bindings?: ContainerBindings,
): void {
  const health = resolveContainerHealth(bindings);
  logger.info("lifecycle.startup", "container started", {
    env: health.env,
    version: health.version,
  });
}

export function registerSigtermHandler(
  processLike: ProcessLike,
  logger: LoggerLike,
  onShutdown: () => void,
): () => void {
  const handleSigterm = (): void => {
    logger.info("lifecycle.sigterm", "received SIGTERM");
    onShutdown();
  };

  processLike.on("SIGTERM", handleSigterm);

  return (): void => {
    if (processLike.off) {
      processLike.off("SIGTERM", handleSigterm);
      return;
    }

    processLike.removeListener?.("SIGTERM", handleSigterm);
  };
}
