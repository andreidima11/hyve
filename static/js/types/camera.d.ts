/** Camera entity attribute hints for live transport selection. */

export type CameraLiveProvider = 'webm' | 'mjpeg' | 'go2rtc' | 'snapshot';

export type CameraMediaKind = 'snapshot' | 'image' | 'stream' | 'play';

export interface CameraEntityAttrs {
    rtsp_url?: string;
    stream_url?: string;
    mjpeg_url?: string;
    live_providers?: CameraLiveProvider[];
    go2rtc_available?: boolean;
    go2rtc_stream?: string;
    [key: string]: unknown;
}

export type CameraLiveTransport = 'go2rtc' | 'webm' | 'mjpeg';
