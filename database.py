from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

# Folosim SQLite pentru simplitate și portabilitate
SQLALCHEMY_DATABASE_URL = "sqlite:///./users.db"

# connect_args e necesar doar pentru SQLite
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    pool_size=10,
    max_overflow=20,
    pool_recycle=3600,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

# Dependency pentru rutele FastAPI
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()