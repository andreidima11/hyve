export declare function hasCameraAuthSession(): boolean;
export declare function getCameraStreamToken(entityId: string): Promise<string>;
export declare function getMediaProxyToken(): Promise<string>;
export declare function peekCameraStreamToken(entityId?: string): string;
export declare function cameraGo2rtcWsUrlSync(entityId: string): string;
