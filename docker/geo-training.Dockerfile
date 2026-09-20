FROM pytorch/pytorch:2.4.1-cuda12.4-cudnn9-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN python -m pip install --no-cache-dir \
    "numpy>=1.24,<2.0" \
    "Pillow>=10.0" \
    "matplotlib>=3.8" \
    "scikit-image>=0.22" \
    "tqdm>=4.66" \
    "pyevtk>=1.6" \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox

USER 10001:10001
WORKDIR /workspace/project
