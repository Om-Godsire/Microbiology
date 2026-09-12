"""
Install script for the ML pipeline dependencies.
Run this once: python install_ml_deps.py
"""
import subprocess
import sys

deps = [
    # PyTorch CPU (lighter for server-side inference)
    ["torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cpu"],
    # MobileSAM (tiny SAM variant)
    ["git+https://github.com/ChaoningZhang/MobileViT-SAM.git"],
    # GMM + scikit-learn
    ["scikit-learn"],
    # Timm (required by MobileSAM's ViT backbone)
    ["timm"],
]

for dep_args in deps:
    print(f"\nInstalling: {' '.join(dep_args)}")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install"] + dep_args,
        capture_output=False
    )
    if result.returncode != 0:
        print(f"WARNING: failed to install {dep_args[0]}")

print("\nAll ML dependencies installed.")
