/**
 * What this machine can run: whether Docker answers, whether it can give
 * containers an NVIDIA GPU, and how much disk is left for ships and data.
 */
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { SystemStatus } from "@pharos/contracts";
import { DockerClient, locateSocket } from "./docker.js";

export const SETUP_LINKS = {
  docker: "https://docs.docker.com/get-started/get-docker/",
  gpu: "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html",
};

export async function detectStatus(dataDir: string, docker: DockerClient | null = connect()): Promise<SystemStatus> {
  const disk = { freeBytes: await freeBytes(dataDir), path: dataDir };
  if (!docker || !(await docker.ping())) {
    return {
      docker: { available: false, error: docker ? "Docker isn't running. Start Docker Desktop (or the Docker service) and try again." : "Docker isn't installed." },
      gpu: { available: false, error: "Needs Docker first." },
      disk,
    };
  }
  const [version, info] = await Promise.all([docker.version(), docker.info()]);
  const nvidia = !!info.Runtimes && "nvidia" in info.Runtimes;
  return {
    docker: { available: true, version: version.Version },
    gpu: nvidia
      ? { available: true, runtime: "nvidia" }
      : {
          available: false,
          error:
            process.platform === "darwin"
              ? "Docker on a Mac can't use the GPU; GPU steps run on the CPU, more slowly."
              : "No NVIDIA container runtime found. Install the NVIDIA Container Toolkit to run GPU steps.",
        },
    disk,
  };
}

/** A client for the local Docker socket, or null when there's none. */
export function connect(): DockerClient | null {
  const socket = locateSocket();
  return socket ? new DockerClient(socket) : null;
}

/** Free space where `dir` is, or will be: a data folder may not exist before first use. */
async function freeBytes(dir: string): Promise<number> {
  for (let d = dir; ; d = dirname(d)) {
    const s = await statfs(d).catch(() => null);
    if (s) return s.bavail * s.bsize;
    if (dirname(d) === d) return 0;
  }
}
