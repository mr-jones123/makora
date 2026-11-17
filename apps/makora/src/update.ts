// `makora update` and `/update`: run the install.sh a release ships against the install directory it lives in.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Install } from "./install.ts";
import { tildify } from "./paths.ts";

/** How this makora updates: `sh` with the installer's arguments and environment, or why it cannot. */
export type UpdatePlan =
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "installer"; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv };

/** The update of `install`: install.sh installs releases as `<install dir>/<version>` next to a `current` link. */
export function updatePlan(install: Install): UpdatePlan {
	if (install.build.kind === "source") {
		return {
			kind: "refused",
			reason: `makora runs from the source checkout at ${tildify(install.root)}; update it with \`git pull\` there`,
		};
	}
	const installDir = dirname(install.root);
	if (!existsSync(join(installDir, "current"))) {
		return {
			kind: "refused",
			reason: `${tildify(install.root)} was not installed by install.sh; install makora with install.sh to update it`,
		};
	}
	return { kind: "installer", args: [install.installer], env: { ...process.env, MAKORA_INSTALL_DIR: installDir } };
}
