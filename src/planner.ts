// El "cerebro" de la sincronización. No toca archivos ni internet:
// solo compara tres listas y decide qué hacer con cada archivo.

export interface RemoteInfo {
	id: string;
	md5: string;
}

export interface BaseInfo {
	id: string;
	md5: string;
}

export type SyncAction =
	| { type: "upload"; path: string; remoteId?: string } // con remoteId = actualizar
	| { type: "download"; path: string; remoteId: string; overwrite: boolean }
	| { type: "delete-local"; path: string }
	| { type: "delete-remote"; path: string; remoteId: string }
	| { type: "conflict"; path: string; remoteId: string }
	| { type: "record"; path: string; remoteId: string; md5: string }
	| { type: "forget"; path: string };

/**
 * local:  ruta -> md5 de lo que hay ahora en la bóveda
 * remote: ruta -> id y md5 de lo que hay ahora en Drive
 * base:   ruta -> lo que era igual en ambos lados la última vez que sincronizamos
 */
export function planSync(
	local: Map<string, string>,
	remote: Map<string, RemoteInfo>,
	base: Record<string, BaseInfo>
): SyncAction[] {
	const paths = new Set<string>([
		...local.keys(),
		...remote.keys(),
		...Object.keys(base),
	]);
	const actions: SyncAction[] = [];

	for (const path of [...paths].sort()) {
		const l = local.get(path); // md5 local, o undefined si no existe
		const r = remote.get(path); // info remota, o undefined si no existe
		const b = base[path]; // lo último sincronizado, o undefined

		// 1. No existe en ningún lado
		if (l === undefined && r === undefined) {
			if (b) actions.push({ type: "forget", path });
			continue;
		}

		// 2. Nunca se había sincronizado
		if (!b) {
			if (r === undefined) {
				actions.push({ type: "upload", path });
			} else if (l === undefined) {
				actions.push({ type: "download", path, remoteId: r.id, overwrite: false });
			} else if (l === r.md5) {
				actions.push({ type: "record", path, remoteId: r.id, md5: l });
			} else {
				actions.push({ type: "conflict", path, remoteId: r.id });
			}
			continue;
		}

		// 3. Ya se había sincronizado, pero falta en la bóveda
		if (l === undefined && r !== undefined) {
			if (r.md5 === b.md5) {
				// Drive no cambió: lo borraste tú aquí
				actions.push({ type: "delete-remote", path, remoteId: r.id });
			} else {
				// Lo borraste aquí pero cambió en Drive: no perdemos el cambio
				actions.push({ type: "download", path, remoteId: r.id, overwrite: false });
			}
			continue;
		}

		// 4. Ya se había sincronizado, pero falta en Drive
		if (r === undefined && l !== undefined) {
			if (l === b.md5) {
				// aquí no cambió: lo borraron en Drive
				actions.push({ type: "delete-local", path });
			} else {
				// lo editaste aquí pero lo borraron en Drive: se vuelve a subir
				actions.push({ type: "upload", path });
			}
			continue;
		}

		// 5. Existe en ambos lados
		if (l !== undefined && r !== undefined) {
			const localChanged = l !== b.md5;
			const remoteChanged = r.md5 !== b.md5;

			if (!localChanged && !remoteChanged) {
				if (r.id !== b.id) {
					actions.push({ type: "record", path, remoteId: r.id, md5: l });
				}
			} else if (localChanged && !remoteChanged) {
				actions.push({ type: "upload", path, remoteId: r.id });
			} else if (!localChanged && remoteChanged) {
				actions.push({ type: "download", path, remoteId: r.id, overwrite: true });
			} else if (l === r.md5) {
				// cambiaron en ambos lados pero quedaron iguales
				actions.push({ type: "record", path, remoteId: r.id, md5: l });
			} else {
				actions.push({ type: "conflict", path, remoteId: r.id });
			}
		}
	}

	return actions;
}