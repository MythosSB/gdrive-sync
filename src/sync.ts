import type { App } from "obsidian";
import { DriveClient, FOLDER_MIME } from "./drive";
import { md5Hex } from "./hash";
import { planSync, RemoteInfo, SyncAction } from "./planner";
import { emptyState, loadState, SyncState } from "./sync-state";

export interface LocalEntry {
	md5: string;
	mtime: number;
	size: number;
}

export interface RemoteEntry extends RemoteInfo {
	modifiedTime?: string;
}

export interface PlanResult {
	actions: SyncAction[];
	rootId: string | null; // carpeta de la bóveda en Drive (null si aún no existe)
	state: SyncState;
	local: Map<string, LocalEntry>;
	remote: Map<string, RemoteEntry>;
	warnings: string[];
}

// Ignoramos cualquier ruta que tenga una carpeta o archivo oculto (empieza con ".").
function isExcluded(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("."));
}

export class SyncEngine {
	constructor(
		private app: App,
		private drive: DriveClient,
		private getFolderName: () => string,
		private getStatePath: () => string
	) {}

	// Compara bóveda, Drive y el último estado sincronizado, y decide qué hacer.
	// No modifica nada (salvo leer).
	async buildPlan(): Promise<PlanResult> {
		const rootId = await this.drive.findFolder(this.getFolderName());

		let state = await loadState(this.app.vault.adapter, this.getStatePath());
		if (rootId === null || state.rootFolderId !== rootId) {
			// Carpeta distinta (o inexistente): el estado guardado ya no sirve.
			state = emptyState(rootId ?? "");
		}

		const local = await this.scanLocal(state);

		let remote = new Map<string, RemoteEntry>();
		let warnings: string[] = [];
		if (rootId !== null) {
			const scan = await this.scanRemote(rootId);
			remote = scan.files;
			warnings = scan.warnings;
		}

		const localHashes = new Map<string, string>();
		for (const [path, entry] of local) localHashes.set(path, entry.md5);

		const base: Record<string, { id: string; md5: string }> = {};
		for (const [path, entry] of Object.entries(state.files)) {
			base[path] = { id: entry.id, md5: entry.md5 };
		}

		const actions = planSync(localHashes, remote, base);
		return { actions, rootId, state, local, remote, warnings };
	}

	// Lee la bóveda y calcula el hash de cada archivo.
	private async scanLocal(state: SyncState): Promise<Map<string, LocalEntry>> {
		const result = new Map<string, LocalEntry>();

		for (const file of this.app.vault.getFiles()) {
			if (isExcluded(file.path)) continue;

			const { mtime, size } = file.stat;
			const known = state.files[file.path];

			let md5: string;
			if (known && known.mtime === mtime && known.size === size) {
				// No ha cambiado desde la última sincronización: reutilizamos el hash.
				md5 = known.md5;
			} else {
				md5 = md5Hex(await this.app.vault.readBinary(file));
			}
			result.set(file.path, { md5, mtime, size });
		}
		return result;
	}

	// Lee Drive y reconstruye la ruta de cada archivo a partir de sus carpetas.
	private async scanRemote(
		rootId: string
	): Promise<{ files: Map<string, RemoteEntry>; warnings: string[] }> {
		const all = await this.drive.listAll();
		const byId = new Map(all.map((f) => [f.id, f]));
		const files = new Map<string, RemoteEntry>();
		const warnings: string[] = [];

		for (const file of all) {
			// Solo archivos normales con hash (se omiten carpetas y documentos de Google)
			if (file.mimeType === FOLDER_MIME || !file.md5Checksum) continue;

			const parts = [file.name];
			let parentId = file.parents?.[0];
			let insideRoot = false;

			for (let depth = 0; parentId && depth < 100; depth++) {
				if (parentId === rootId) {
					insideRoot = true;
					break;
				}
				const parent = byId.get(parentId);
				if (!parent) break;
				parts.unshift(parent.name);
				parentId = parent.parents?.[0];
			}
			if (!insideRoot) continue; // pertenece a otra carpeta (por ejemplo, otra bóveda)

			const path = parts.join("/");
			const entry: RemoteEntry = {
				id: file.id,
				md5: file.md5Checksum,
				modifiedTime: file.modifiedTime,
			};

			const existing = files.get(path);
			if (existing) {
				warnings.push(`Hay varios archivos con la misma ruta en Drive: ${path}`);
				// nos quedamos con el modificado más recientemente
				if ((entry.modifiedTime ?? "") <= (existing.modifiedTime ?? "")) continue;
			}
			files.set(path, entry);
		}
		return { files, warnings };
	}
}