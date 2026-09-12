import os
from ultralytics import YOLO

def main():
    # Define paths
    dataset_yaml = "e:/Microbiology/data/yolo_dataset/dataset.yaml"
    
    if not os.path.exists(dataset_yaml):
        print(f"Error: Could not find {dataset_yaml}")
        return
        
    print(f"Loading YOLOv8n model...")
    # Load a model (YOLOv8 nano is good for quick training)
    model = YOLO("yolov8n.pt")
    
    print("Starting training...")
    # Train the model
    results = model.train(
        data=dataset_yaml,
        epochs=50,       # Number of epochs (can adjust later)
        imgsz=640,       # Image size
        batch=4,         # Batch size
        device="cpu",    # Force CPU for local testing (remove or change to 'cuda'/'mps' if GPU available)
        project="e:/Microbiology/models", # Save to models folder
        name="petri_dish_model"
    )
    print("\nTraining complete! Model saved in e:/Microbiology/models/petri_dish_model")

if __name__ == "__main__":
    main()
