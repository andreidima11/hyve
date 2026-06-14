"""Tapo RTSP URL building."""

from components.tapo.entity import build_rtsp_url, TapoEntity


def test_build_rtsp_url_stream1():
    url = build_rtsp_url("192.168.0.125", "camuser", "secret", hd=True)
    assert url == "rtsp://camuser:secret@192.168.0.125:554/stream1"


def test_build_rtsp_url_stream2():
    url = build_rtsp_url("192.168.0.125", "camuser", "pass", hd=False)
    assert url == "rtsp://camuser:pass@192.168.0.125:554/stream2"


def test_build_rtsp_url_encodes_special_chars():
    url = build_rtsp_url("192.168.0.125", "user@x", "p@ss:wrd", hd=True)
    assert url == "rtsp://user%40x:p%40ss%3Awrd@192.168.0.125:554/stream1"


def test_rtsp_credentials_prefers_rtsp_fields():
    inst = TapoEntity(
        entry_id="e1",
        entry_data={
            "host": "192.168.0.125",
            "username": "cloudadmin",
            "password": "cloudpass",
            "rtsp_username": "camuser",
            "rtsp_password": "campass",
        },
        entry_title="Cam",
    )
    creds = inst._rtsp_credentials()
    assert creds.username == "camuser"
    assert creds.password == "campass"


def test_rtsp_credentials_fallback_to_main():
    inst = TapoEntity(
        entry_id="e1",
        entry_data={
            "host": "192.168.0.125",
            "username": "camuser",
            "password": "campass",
        },
        entry_title="Cam",
    )
    creds = inst._rtsp_credentials()
    assert creds.username == "camuser"
    assert creds.password == "campass"
