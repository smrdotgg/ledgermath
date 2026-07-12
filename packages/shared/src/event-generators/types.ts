export enum DataType {
	String = "string",
	Number = "number",
}

export enum EventGeneratorCode {
	FetchSingleByteFromS3 = "fetch_single_byte_from_s3",
}

export interface Parameter {
	key: string;
	description: string;
	type: DataType;
}

export interface EventGenerator {
	code: EventGeneratorCode;
	requiredParameters: Parameter[];
	outputs: Parameter[];
	description: string;
	explanation: string;
}
