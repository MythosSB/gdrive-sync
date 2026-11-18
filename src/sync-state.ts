import type { DataAdapter } from "obsidian";

// Lo que recordamos de cada archivo la última vez que quedó igual en ambos lados.
export interface StateEntry {
	id: string; // id del archivo en Drive
	md5: string; // contenido sincronizado (hash)
	mtime: number; // fecha de modificación local en ese momento
	size: number; // tamaño local en ese momento
}

export interface SyncState {
	version: 1;
	rootFolderId: string; // carpeta de Drive a la que pertenece este estado
	files: Record<string, StateEntry>; // clave: ruta dentro de la bóveda
}

export function emptyState(rootFolderId = ""): SyncState {
	return { version: 1, rootFolderId, files: {} };
}

export async function loadState(
	adapter: DataAdapter,
	path: string
): Promise<SyncState> {
	try {
		if (!(await adapter.exists(path))) return emptyState();
		const parsed = JSON.parse(await adapter.read(path)) as Partial<SyncState>;
		if (parsed.version !== 1 || typeof parsed.files !== "object" || !parsed.files) {
			return emptyState();
		}
		return {
			version: 1,
			rootFolderId: parsed.rootFolderId ?? "",
			files: parsed.files,
		};
	} catch (error) {
		// Si el archivo está dañado empezamos de cero: es seguro, porque
		// las diferencias se tratarán como conflictos y no se borra nada.
		console.warn("GDrive Sync: no se pudo leer sync-state.json", error);
		return emptyState();
	}
}

export async function saveState(
	adapter: DataAdapter,
	path: string,
	state: SyncState
): Promise<void> {
	await adapter.write(path, JSON.stringify(state));
}