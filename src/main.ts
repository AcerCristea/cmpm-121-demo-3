const button = document.createElement("button");
button.textContent = "Click Me!";

button.onclick = () => {
  alert("you clicked the button!");
};

document.body.appendChild(button);
