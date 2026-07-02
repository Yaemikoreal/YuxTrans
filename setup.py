"""
YuxTrans - AI Translation Tool
响应速度是生命，翻译准度是底线
"""

from setuptools import setup, find_packages

setup(
    name="yuxtrans",
    version="0.1.0",
    author="YuxTrans Team",
    author_email="team@yuxtrans.dev",
    description="AI Translation Tool - Fast Response, Accurate Translation",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    url="https://github.com/Yaemikoreal/yuxtrans",
    packages=find_packages(),
    python_requires=">=3.10",
    install_requires=[
        "httpx>=0.24.0",
        "pyyaml>=6.0",
    ],
    extras_require={
        "desktop": ["PyQt6>=6.4.0"],
        "local": ["ollama>=0.1.0"],
        "macos": ["pynput>=1.7.0"],
        "dev": [
            "pytest>=7.0.0",
            "pytest-asyncio>=0.21.0",
        ],
    },
    entry_points={
        "console_scripts": [
            "yuxtrans=yuxtrans.desktop.app:main",
        ],
    },
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "Intended Audience :: End Users/Desktop",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Text Processing :: Linguistic :: Translation",
    ],
)
