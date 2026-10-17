export {};

declare global {
  interface Window {
    __NIO_NATIVE__?: Readonly<{
      version: number;
      surface: "dashboard" | "tray";
    }>;
    webkit?: {
      messageHandlers?: {
        nioBridge?: {
          postMessage(message: unknown): Promise<unknown>;
        };
      };
    };
  }
}
