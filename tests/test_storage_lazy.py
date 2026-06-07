"""Lazy Chroma init in storage.py."""


def test_lazy_collection_proxy_delegates(monkeypatch):
    import storage

    calls = []

    class FakeColl:
        marker = "ok"

    def fake_get_collection():
        calls.append(1)
        return FakeColl()

    monkeypatch.setattr(storage, "get_collection", fake_get_collection)
    proxy = storage._LazyCollectionProxy()
    assert proxy.marker == "ok"
    assert len(calls) == 1


def test_get_collection_cached(monkeypatch):
    import storage

    storage._collection = None
    created = []

    class FakeColl:
        def count(self):
            return 0

    class FakeDB:
        def get_or_create_collection(self, **kwargs):
            created.append(1)
            return FakeColl()

    monkeypatch.setattr(storage, "get_client_db", lambda: FakeDB())
    monkeypatch.setattr(storage, "_get_embedding_fn", lambda: object())
    monkeypatch.setattr(storage, "_is_fallback_embedding", lambda: False)

    first = storage.get_collection()
    second = storage.get_collection()
    assert first is second
    assert len(created) == 1
    storage._collection = None
