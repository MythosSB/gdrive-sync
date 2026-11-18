import SparkMD5 from "spark-md5";

// Calcula el hash MD5 (en hexadecimal) del contenido de un archivo.
// Drive guarda el mismo MD5 de cada archivo, así que podemos compararlos directamente.
export function md5Hex(data: ArrayBuffer): string {
	return SparkMD5.ArrayBuffer.hash(data);
}