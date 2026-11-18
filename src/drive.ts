import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,parents,md5Checksum,modifiedTime,size";

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	parents?: string[];
	md5Checksum?: string;
	modifiedTime?: string;
	size?: string;
}

// Error de la API de Drive, con el código HTTP para poder reaccionar según el caso.
export class DriveError extends Error {
	constructor(public status: number, message: string) {
		super(`Drive (${status}): ${message}`);
		this.name = "DriveError";
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Escapa comillas y barras para usar un nombre dentro de una búsqueda de Drive.
function escapeQuery(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Convierte texto a ArrayBuffer (UTF-8), útil para subir notas.
export function textToArrayBuffer(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer;
}

// Arma a mano el cuerpo "multipart": metadatos (JSON) + contenido del archivo.
function buildMultipartBody(
	metadata: object,
	data: ArrayBuffer,
	mimeType: string,
	boundary: string
): ArrayBuffer {
	const encoder = new TextEncoder();
	const head = encoder.encode(
		`--${boundary}\r\n` +
			`Content-Type: application/json; charset=UTF-8\r\n\r\n` +
			`${JSON.stringify(metadata)}\r\n` +
			`--${boundary}\r\n` +
			`Content-Type: ${mimeType}\r\n\r\n`
	);
	const tail = encoder.encode(`\r\n--${boundary}--`);

	const body = new Uint8Array(head.length + data.byteLength + tail.length);
	body.set(head, 0);
	body.set(new Uint8Array(data), head.length);
	body.set(tail, head.length + data.byteLength);
	return body.buffer;
}

export class DriveClient {
	// Caché ruta -> id de carpeta, para no preguntar a Drive lo mismo muchas veces.
	private folderCache = new Map<string, string>();

	constructor(private getToken: () => Promise<string>) {}

	// Hace una petición con el token y reintenta si Drive pide ir más despacio.
	private async request(params: RequestUrlParam): Promise<RequestUrlResponse> {
		const maxAttempts = 4;

		for (let attempt = 1; ; attempt++) {
			const token = await this.getToken();
			const response = await requestUrl({
				...params,
				headers: { ...params.headers, Authorization: `Bearer ${token}` },
				throw: false,
			});

			if (response.status >= 200 && response.status < 300) return response;

			const message = this.errorMessage(response);
			const rateLimited =
				response.status === 429 ||
				response.status >= 500 ||
				(response.status === 403 && /rate/i.test(message));

			if (rateLimited && attempt < maxAttempts) {
				// espera 1s, 2s, 4s... más un poquito al azar
				await sleep(2 ** (attempt - 1) * 1000 + Math.random() * 250);
				continue;
			}
			throw new DriveError(response.status, message);
		}
	}

	private errorMessage(response: RequestUrlResponse): string {
		try {
			const data = response.json as {
				error?: { message?: string; errors?: { reason?: string }[] };
			};
			const reason = data.error?.errors?.[0]?.reason ?? "";
			return `${data.error?.message ?? "error desconocido"} ${reason}`.trim();
		} catch {
			return response.text || "error desconocido";
		}
	}

	// ---------- Carpetas ----------

	async findFolder(name: string, parentId = "root"): Promise<string | null> {
		const q =
			`name='${escapeQuery(name)}' and mimeType='${FOLDER_MIME}' ` +
			`and '${parentId}' in parents and trashed=false`;
		const params = new URLSearchParams({ q, fields: "files(id,name)" });
		const response = await this.request({
			url: `${API}/files?${params.toString()}`,
			method: "GET",
		});
		const data = response.json as { files: { id: string }[] };
		return data.files[0]?.id ?? null;
	}

	async createFolder(name: string, parentId = "root"): Promise<string> {
		const response = await this.request({
			url: `${API}/files?fields=id`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({
				name,
				mimeType: FOLDER_MIME,
				parents: [parentId],
			}),
		});
		return (response.json as { id: string }).id;
	}

	// Devuelve la carpeta si existe; si no, la crea.
	async ensureFolder(name: string, parentId = "root"): Promise<string> {
		const key = `${parentId}/${name}`;
		const cached = this.folderCache.get(key);
		if (cached) return cached;

		const id =
			(await this.findFolder(name, parentId)) ??
			(await this.createFolder(name, parentId));
		this.folderCache.set(key, id);
		return id;
	}

	// Asegura una ruta completa, por ejemplo "Proyectos/2026/Notas".
	async ensureFolderPath(path: string, rootId = "root"): Promise<string> {
		let current = rootId;
		for (const part of path.split("/").filter((p) => p !== "")) {
			current = await this.ensureFolder(part, current);
		}
		return current;
	}

	// ---------- Archivos ----------

		// Lista los archivos que hay dentro de una carpeta.
	async listFiles(parentId: string): Promise<DriveFile[]> {
		return this.listByQuery(`'${parentId}' in parents and trashed=false`);
	}

	// Lista TODOS los archivos y carpetas que el plugin puede ver (los que él creó).
	async listAll(): Promise<DriveFile[]> {
		return this.listByQuery("trashed=false");
	}

	private async listByQuery(q: string): Promise<DriveFile[]> {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;

		do {
			const params = new URLSearchParams({
				q,
				fields: `nextPageToken,files(${FILE_FIELDS})`,
				pageSize: "1000",
			});
			if (pageToken) params.set("pageToken", pageToken);

			const response = await this.request({
				url: `${API}/files?${params.toString()}`,
				method: "GET",
			});
			const data = response.json as {
				nextPageToken?: string;
				files: DriveFile[];
			};
			files.push(...data.files);
			pageToken = data.nextPageToken;
		} while (pageToken);

		return files;
	}

	async uploadFile(
		name: string,
		parentId: string,
		data: ArrayBuffer,
		mimeType = "application/octet-stream"
	): Promise<DriveFile> {
		const boundary = `gdrivesync${Date.now()}${Math.random().toString(36).slice(2)}`;
		const body = buildMultipartBody(
			{ name, parents: [parentId] },
			data,
			mimeType,
			boundary
		);
		const response = await this.request({
			url: `${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`,
			method: "POST",
			contentType: `multipart/related; boundary=${boundary}`,
			body,
		});
		return response.json as DriveFile;
	}

	// Reemplaza el contenido de un archivo que ya existe.
	async updateFile(
		fileId: string,
		data: ArrayBuffer,
		mimeType = "application/octet-stream"
	): Promise<DriveFile> {
		const response = await this.request({
			url: `${UPLOAD_API}/files/${fileId}?uploadType=media&fields=${FILE_FIELDS}`,
			method: "PATCH",
			contentType: mimeType,
			body: data,
		});
		return response.json as DriveFile;
	}

	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const response = await this.request({
			url: `${API}/files/${fileId}?alt=media`,
			method: "GET",
		});
		return response.arrayBuffer;
	}

	// Manda el archivo a la papelera de Drive (se puede recuperar), no lo borra del todo.
	async trashFile(fileId: string): Promise<void> {
		await this.request({
			url: `${API}/files/${fileId}`,
			method: "PATCH",
			contentType: "application/json",
			body: JSON.stringify({ trashed: true }),
		});
	}
}