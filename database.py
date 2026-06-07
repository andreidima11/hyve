from sqlalchemy import create_engine, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

# Folosim SQLite pentru simplitate și portabilitate
SQLALCHEMY_DATABASE_URL = "sqlite:///./users.db"

# connect_args e necesar doar pentru SQLite. SQLite write throughput is
# inherently single-writer, so a giant pool just wastes file descriptors.
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    pool_size=5,
    max_overflow=10,
    pool_timeout=3,
    pool_recycle=3600,
    pool_pre_ping=True,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

# Dependency pentru rutele FastAPI
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()