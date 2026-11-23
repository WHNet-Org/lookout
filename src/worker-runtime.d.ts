declare module "cloudflare:sockets" {
  export function connect(
    address: string | import("@cloudflare/workers-types").SocketAddress,
    options?: import("@cloudflare/workers-types").SocketOptions,
  ): import("@cloudflare/workers-types").Socket;
}

declare module "cloudflare:workers" {
  export const WorkerEntrypoint: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.WorkerEntrypoint;
}
